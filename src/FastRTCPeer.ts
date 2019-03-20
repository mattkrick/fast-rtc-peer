import EventEmitter from 'eventemitter3'
import shortid from 'shortid'
import StrictEventEmitter from 'strict-event-emitter-types'

declare global {
  // hacks to get around the errors in lib.dom.d
  interface Window {
    RTCIceCandidate: typeof RTCIceCandidate
    RTCPeerConnection: typeof RTCPeerConnection
    RTCSessionDescription: typeof RTCSessionDescription
  }

  interface RTCConfiguration {
    sdpSemantics?: 'plan-b' | 'unified-plan' | string | undefined
  }

  interface RTCDataChannel {
    send (data: DataPayload): void
  }

  // overload the transceiver for our own use
  interface RTCRtpTransceiver {
    name?: string
  }
}

export type PayloadToServer = CandidatePayload | OfferPayload | AnswerPayload

export interface FastRTCPeerEvents {
  signal: (payload: PayloadToServer, peer: FastRTCPeer) => void
  data: (data: DataPayload, peer: FastRTCPeer) => void
  open: (peer: FastRTCPeer) => void
  close: (peer: FastRTCPeer) => void
  error: (error: Error, peer: FastRTCPeer) => void
  stream: (stream: MediaStream, name: string, peer: FastRTCPeer) => void
  connection: (state: RTCIceConnectionState, peer: FastRTCPeer) => void
}

export type DataPayload = string | Blob | ArrayBuffer | ArrayBufferView

export interface PeerConfig {
  readonly id?: string
  readonly isOfferer?: boolean
  readonly userId?: string
  readonly streams?: StreamDictInput
  readonly wrtc?: WRTC
  readonly rtcConfig?: RTCConfiguration
}

export interface WRTC {
  RTCIceCandidate: typeof RTCIceCandidate
  RTCPeerConnection: typeof RTCPeerConnection
  RTCSessionDescription: typeof RTCSessionDescription
}

export interface OfferPayload {
  readonly type: 'offer'
  readonly sdp: string
}

export interface CandidatePayload {
  readonly type: 'candidate'
  readonly candidate: RTCIceCandidateInit | null
}

export interface AnswerPayload {
  readonly type: 'answer'
  readonly sdp: string
}

export type PayloadFromServer = OfferPayload | CandidatePayload | AnswerPayload

export type FastRTCPeerEmitter = {new (): StrictEventEmitter<EventEmitter, FastRTCPeerEvents>}

export type TrackKind = 'audio' | 'video'

interface TrackConfig {
  readonly track: MediaStreamTrack
  readonly setParameters: (sender: RTCRtpSender) => Promise<void>
}

type TrackConfigOrKind = TrackConfig | TrackKind

interface TrackDict {
  [trackName: string]: TrackConfigOrKind | null
}

export interface StreamDict {
  [streamName: string]: TrackDict
}

export interface StreamDictInput {
  [streamName: string]: TrackDict | MediaStream | undefined
}

interface RemoteStreams {
  [name: string]: MediaStream
}

interface StreamConfigEntry {
  readonly streamName: string
  readonly transceiverName: string
  trackConfigOrKind: TrackConfigOrKind | null
}

interface ClosePayload {
  readonly type: 'close'
}

interface TransceiverSynPayload {
  readonly type: 'transSyn'
  readonly name: string
  readonly isOfferer: boolean
}

interface TransceiverAckPayload {
  readonly type: 'transAck'
  readonly name: string
}

interface StreamPayload {
  readonly type: 'stream'
  readonly streamName: string
  readonly transceiverNames: string[]
}

interface TransceiverQueuePayload {
  readonly type: 'transQueue'
  readonly transceiverName: string
}

type InternalPayload =
  | ClosePayload
  | TransceiverSynPayload
  | TransceiverAckPayload
  | StreamPayload
  | TransceiverQueuePayload

const replyWithTrack = async (
  transceiver: RTCRtpTransceiver,
  trackConfigOrKind: TrackConfigOrKind | null
) => {
  if (trackConfigOrKind && typeof trackConfigOrKind !== 'string') {
    const { track, setParameters } = trackConfigOrKind
    transceiver.direction = 'sendrecv'
    if (setParameters) {
      await setParameters(transceiver.sender)
    }
    await transceiver.sender.replaceTrack(track)
  }
}

class FastRTCPeer extends (EventEmitter as FastRTCPeerEmitter) {
  static defaultICEServers: Array<RTCIceServer> = [
    {
      urls: 'stun:stun.l.google.com:19302'
    },
    {
      urls: 'stun:global.stun.twilio.com:3478?transport=udp'
    }
  ]
  static defaultConfig = {
    iceServers: FastRTCPeer.defaultICEServers,
    sdpSemantics: 'unified-plan'
  }

  static generateID = () => {
    return shortid.generate()
  }

  static fromStreamShorthand = (streams: StreamDictInput | undefined) => {
    const returnStreams = {} as StreamDict
    if (streams) {
      Object.keys(streams).forEach((streamName) => {
        const streamOrConfig = streams[streamName]
        returnStreams[streamName] =
          streamOrConfig instanceof MediaStream
            ? {
              audio: { track: streamOrConfig.getAudioTracks()[0] } as TrackConfig,
              video: { track: streamOrConfig.getVideoTracks()[0] } as TrackConfig
            }
            : streamOrConfig || {}
      })
    }
    return returnStreams
  }

  private readonly dataChannelQueue: InternalPayload[] = []
  private readonly isOfferer: boolean
  private readonly wrtc: WRTC | Window
  private readonly pendingTransceivers = new Set<string>()
  private readonly remoteStreams: RemoteStreams = {}
  private readonly streamConfig: StreamConfigEntry[] = []
  private readonly transceiverNameQueue: string[] = []
  private readonly transceiverQueue: RTCRtpTransceiver[] = []
  private negotiationCount = 0
  // if dataChannel exists, then the connection is ready
  private dataChannel: RTCDataChannel | null = null
  readonly id: string
  readonly peerConnection!: RTCPeerConnection
  userId: string | null

  constructor (userConfig: PeerConfig = {}) {
    super()
    const { id, isOfferer, userId, streams, wrtc, rtcConfig = {} } = userConfig
    this.id = id || FastRTCPeer.generateID()
    this.isOfferer = isOfferer || false
    this.userId = userId || null
    this.wrtc = wrtc || window
    this.peerConnection = new this.wrtc.RTCPeerConnection({
      ...FastRTCPeer.defaultConfig,
      ...rtcConfig
    })
    this.setupPeer()
    this.setupStreams(FastRTCPeer.fromStreamShorthand(streams), true)
  }

  private setupPeer () {
    this.peerConnection.onicecandidate = this.onIceCandidate
    this.peerConnection.oniceconnectionstatechange = this.onIceConnectionStateChange
    this.peerConnection.onnegotiationneeded = this.onNegotiationNeeded
    this.peerConnection.ontrack = this.onTrack
    this.addDataChannel('fast')
  }

  private onIceCandidate = (event: RTCPeerConnectionIceEvent) => {
    // if candidate is null, then the trickle is complete & iceConnectionState moves to completed
    const payload = { type: 'candidate', candidate: event.candidate } as CandidatePayload
    this.emit('signal', payload, this)
  }

  private onIceConnectionStateChange = () => {
    const { iceConnectionState } = this.peerConnection
    switch (iceConnectionState) {
      // Note: does NOT close on 'disconnected' because that is only temporary
      case 'closed':
      case 'failed':
        this.close()
        break
    }
    this.emit('connection', iceConnectionState, this)
  }

  private onNegotiationNeeded = async () => {
    const neg = ++this.negotiationCount
    const offer = await this.peerConnection.createOffer()
    // https://bugs.chromium.org/p/chromium/issues/detail?id=740501
    // if renegotiation is required, don't set a stale description
    if (neg !== this.negotiationCount) return
    await this.peerConnection.setLocalDescription(offer).catch((e: Error) => {
      this.emit('error', e, this)
    })
    // firefox doesn't support toJSON
    const { sdp, type } = offer
    this.emit('signal', { sdp, type } as OfferPayload, this)
  }

  private addTrackToStream = (transceiverName: string, track: MediaStreamTrack) => {
    const streamNames = new Set(
      this.streamConfig
        .filter((config) => config.transceiverName === transceiverName)
        .map(({ streamName }) => streamName)
    )
    streamNames.forEach((streamName) => {
      let stream = this.remoteStreams[streamName]
      if (!stream) {
        stream = this.remoteStreams[streamName] = new MediaStream([track])
      } else {
        stream.addTrack(track)
      }
      const streamCount = this.streamConfig.filter((config) => config.streamName === streamName)
        .length
      if (streamCount === stream.getTracks().length) {
        this.emit('stream', stream, streamName, this)
      }
    })
  }

  private handleTransceiverName = async (transceiver: RTCRtpTransceiver) => {
    const name = this.transceiverNameQueue.shift()
    if (name) {
      transceiver.name = name
      const { trackConfigOrKind } = this.streamConfig.find(
        (config) => config.transceiverName === name
      )!
      // if we've been waiting to reply, add our track now
      await replyWithTrack(transceiver, trackConfigOrKind)
      this.addTrackToStream(transceiver.name, transceiver.receiver.track)
    } else {
      this.transceiverQueue.push(transceiver)
    }
  }

  private onTrack = async (e: RTCTrackEvent) => {
    const { track, transceiver } = e
    if (transceiver.name) {
      this.addTrackToStream(transceiver.name, track)
    } else {
      // we got the transceiver before a message was pushed to the queue (usually this happens on init)
      // we need to wait until that message comes in via transceiverNameQueue
      this.handleTransceiverName(transceiver).catch()
    }
  }

  private handleAnswer (initSDP: RTCSessionDescriptionInit) {
    const desc = new this.wrtc.RTCSessionDescription(initSDP) as RTCSessionDescriptionInit
    this.peerConnection.setRemoteDescription(desc).catch((e: Error) => {
      this.emit('error', e, this)
    })
  }

  private handleCandidate (candidateObj: RTCIceCandidateInit | null) {
    if (!candidateObj) return
    const candidate = new this.wrtc.RTCIceCandidate(candidateObj)
    this.peerConnection.addIceCandidate(candidate).catch((e: Error) => {
      this.emit('error', e, this)
    })
  }

  private handleOffer = async (initSdp: RTCSessionDescriptionInit) => {
    // typescript defs for RTCSessionDescription should return RTCSessionDescription, not the init
    const remoteSdp = new this.wrtc.RTCSessionDescription(initSdp)
    await this.peerConnection.setRemoteDescription(remoteSdp).catch((e: Error) => {
      this.emit('error', e, this)
    })

    const answer = await this.peerConnection.createAnswer()
    const { sdp, type } = answer
    this.emit('signal', { type, sdp } as AnswerPayload, this)
    await this.peerConnection.setLocalDescription(answer).catch((e: Error) => {
      this.emit('error', e, this)
    })
  }

  private handleInternalMessage = (data: DataPayload) => {
    if (typeof data !== 'string' || !data.startsWith('@fast')) return false
    const payload = JSON.parse(data.substring(6)) as InternalPayload
    switch (payload.type) {
      case 'close':
        this.close()
        break
      case 'transQueue':
        this.transceiverNameQueue.push(payload.transceiverName)
        this.handleTransceiverName(this.transceiverQueue.shift()!).catch()
        break
      case 'transSyn':
        const existingTransceiver = this.peerConnection
          .getTransceivers()
          .find((transceiver) => transceiver.name === payload.name)
        // if the transceiver already exists, ignore the syn
        if (existingTransceiver) break
        // if both have sent out a syn, ignore theirs if we're the offerer (tiebreaker)
        if (this.pendingTransceivers.has(payload.name) && !payload.isOfferer) break
        // give the next track that comes in the proper name & don't send out a syn for this transceiver
        this.transceiverNameQueue.push(payload.name)
        this.sendInternal({ type: 'transAck', name: payload.name })
        this.pendingTransceivers.delete(payload.name)
        break
      case 'transAck':
        this.pendingTransceivers.delete(payload.name)
        const entry = this.streamConfig.find((config) => config.transceiverName === payload.name)
        if (!entry || !entry.trackConfigOrKind) throw new Error(`Invalid config for ack ${entry}`)
        const { trackConfigOrKind } = entry
        const trackOrKind =
          typeof trackConfigOrKind === 'string' ? trackConfigOrKind : trackConfigOrKind.track
        // mark any pending negotiations as stale since we're about to create a new transceiver
        this.negotiationCount++
        const transceiver = this.peerConnection.addTransceiver(trackOrKind)
        transceiver.name = payload.name
        if (typeof trackConfigOrKind !== 'string' && trackConfigOrKind.setParameters) {
          trackConfigOrKind.setParameters(transceiver.sender).catch()
        }
        break
      case 'stream':
        const { streamName, transceiverNames } = payload
        transceiverNames.forEach((transceiverName) => {
          const existingConfig = this.streamConfig.find(
            (config) =>
              config.streamName === streamName && config.transceiverName === transceiverName
          )
          if (!existingConfig) {
            this.streamConfig.push({ streamName, transceiverName, trackConfigOrKind: null })
          }
        })
        break
    }
    return true
  }

  private sendInternal (payload: InternalPayload) {
    if (!this.dataChannel) {
      this.dataChannelQueue.push(payload)
    } else {
      this.dataChannel.send(`@fast/${JSON.stringify(payload)}`)
    }
  }

  private setChannelEvents = (channel: RTCDataChannel) => {
    channel.onmessage = (event: MessageEvent) => {
      if (!this.handleInternalMessage(event.data)) {
        this.emit('data', event.data, this)
      }
    }
    channel.onopen = () => {
      this.dataChannel = channel
      this.dataChannelQueue.forEach((payload) => this.sendInternal(payload))
      this.dataChannelQueue.length = 0
      this.emit('open', this)
    }
    channel.onclose = () => {
      this.emit('close', this)
    }
  }

  private addDataChannel (label: string, dataChannelDict?: RTCDataChannelInit) {
    if (this.isOfferer) {
      const dataChannel = this.peerConnection.createDataChannel(label, dataChannelDict)
      this.setChannelEvents(dataChannel)
    } else {
      this.peerConnection.ondatachannel = (e) => {
        this.peerConnection.ondatachannel = null
        this.setChannelEvents(e.channel)
      }
    }
  }

  private async setTrack (
    transceiverName: string,
    trackConfigOrKind: TrackConfigOrKind,
    isInit: boolean
  ) {
    const existingTransceiver = this.peerConnection
      .getTransceivers()
      .find((transceiver) => transceiver.name === transceiverName)
    if (existingTransceiver) {
      await replyWithTrack(existingTransceiver, trackConfigOrKind)
    } else if (!this.transceiverNameQueue.includes(transceiverName)) {
      // if this.transceiverNameQueue includes the name, that means we already approved the peer's syn to create the transceiver
      // when the peer's initial track arrives, we'll reply with the trackConfigOrKind stored in this.streamConfig
      // setTrack could be called multiple times & we'll send a new syn each time (in case of network issues, UDP fun stuff, etc.)
      if (isInit && this.isOfferer) {
        const trackOrKind =
          typeof trackConfigOrKind === 'string' ? trackConfigOrKind : trackConfigOrKind.track
        this.negotiationCount++
        const transceiver = this.peerConnection.addTransceiver(trackOrKind)
        transceiver.name = transceiverName
        this.sendInternal({ type: 'transQueue', transceiverName })
      } else {
        this.sendInternal({ type: 'transSyn', name: transceiverName, isOfferer: this.isOfferer })
        this.pendingTransceivers.add(transceiverName)
      }
    }
  }

  private setupStreams = (streams: StreamDict, isInit = false) => {
    Object.keys(streams).forEach((streamName) => {
      const trackDict = streams[streamName]
      const transceiverNames = Object.keys(trackDict)
      this.sendInternal({ type: 'stream', streamName, transceiverNames })
      transceiverNames.forEach((transceiverName) => {
        const trackConfigOrKind = trackDict[transceiverName]
        const existingConfig = this.streamConfig.find(
          (config) => config.streamName === streamName && config.transceiverName === transceiverName
        )
        if (!existingConfig) {
          this.streamConfig.push({ streamName, transceiverName, trackConfigOrKind })
        } else {
          existingConfig.trackConfigOrKind = trackConfigOrKind
        }
        if (trackConfigOrKind) {
          this.setTrack(transceiverName, trackConfigOrKind, isInit).catch()
        }
      })
    })
  }

  addStreams = (streams: StreamDict) => {
    // if called after destruction, ignore
    if (!this.peerConnection) return
    this.setupStreams(streams)
  }

  async muteTrack (name: string) {
    const transceiver = this.peerConnection
      .getTransceivers()
      .find((transceiver) => transceiver.name === name)
    if (!transceiver) throw new Error(`Invalid track name: ${name}`)
    const { track } = transceiver.sender
    await transceiver.sender.replaceTrack(null)
    transceiver.direction = 'recvonly'
    if (track) {
      track.enabled = false
      // HACK CHROME73+: stop() is required to alert the browser that the hardware is not in use
      track.stop()
    }
  }

  close () {
    // This prevents stray event handlers from being triggered while the connection is in the process of closing, potentially causing errors.
    this.peerConnection.ontrack = null
    this.peerConnection.onicecandidate = null
    this.peerConnection.oniceconnectionstatechange = null
    this.peerConnection.onnegotiationneeded = null
    this.peerConnection.ondatachannel = null
    if (this.dataChannel) {
      this.sendInternal({ type: 'close' })
      // this.dataChannel.onclose = null
      this.dataChannel.onmessage = null
      this.dataChannel = null
    }
    // transceivers & tracks are not shut down because they may be shared across peers
    this.peerConnection.close()
    ;(this.peerConnection as any) = null
  }

  send = (data: DataPayload) => {
    this.dataChannel && this.dataChannel.send(data)
  }

  dispatch (payload: PayloadFromServer) {
    switch (payload.type) {
      case 'offer':
        this.handleOffer(payload).catch()
        break
      case 'candidate':
        this.handleCandidate(payload.candidate)
        break
      case 'answer':
        this.handleAnswer(payload)
    }
  }
}

export default FastRTCPeer

// refresh top
// add video to top
// refresh bottom
// mute video from top
