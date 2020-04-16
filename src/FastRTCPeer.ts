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
  [streamName: string]: MediaStream
}

interface StreamConfigEntry {
  readonly streamName: string
  readonly transceiverName: string
  trackConfigOrKind: TrackConfigOrKind | null
}

interface ClosePayload {
  readonly type: 'close'
}

interface MidNamePayload {
  readonly type: 'midOffer'
  readonly transceiverName: string
  readonly mid: string
}

interface RequestTransceiverPayload {
  readonly type: 'transceiverRequest'
  readonly transceiverName: string
  readonly kind: TrackKind
}

interface StreamPayload {
  readonly type: 'stream'
  readonly streamName: string
  readonly transceiverNames: string[]
}

type InternalPayload = ClosePayload | MidNamePayload | RequestTransceiverPayload | StreamPayload

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
  readonly remoteStreams: RemoteStreams = {}
  private readonly streamConfig: StreamConfigEntry[] = []
  private readonly midsWithoutNames = new Set<string>()
  private readonly pendingTransceivers: Array<{
    transceiver: RTCRtpTransceiver
    transceiverName: string
  }> = []
  private negotiationCount = 0
  private midLookup: {[transceiverName: string]: string} = {}
  // if dataChannel exists, then the connection is ready
  private dataChannel: RTCDataChannel | null = null
  readonly id: string
  readonly peerConnection: RTCPeerConnection
  userId: string | null

  constructor (userConfig: PeerConfig = {}) {
    super()
    const { id, isOfferer, userId, streams, wrtc, rtcConfig = {} } = userConfig
    this.id = id || FastRTCPeer.generateID()
    this.isOfferer = isOfferer || false
    this.userId = userId || null
    this.wrtc = wrtc || window
    const { RTCPeerConnection } = this.wrtc
    if (!RTCPeerConnection) throw new Error('Client does not support WebRTC')
    this.peerConnection = new RTCPeerConnection({
      ...FastRTCPeer.defaultConfig,
      ...rtcConfig
    })
    this.setupPeer()
    this.addStreams(FastRTCPeer.fromStreamShorthand(streams))
  }

  private setupPeer () {
    if (!this.peerConnection) return
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
    // now that a mid exists, move it from pending to the lookup
    this.pendingTransceivers.slice().forEach(({ transceiver: { mid }, transceiverName }, idx) => {
      if (!mid) return
      this.midLookup[transceiverName] = mid
      this.sendInternal({ type: 'midOffer', mid, transceiverName })
      this.pendingTransceivers.splice(idx, 1)
    })

    // firefox doesn't support toJSON
    const { sdp, type } = offer

    this.emit('signal', { sdp, type } as OfferPayload, this)
  }

  private addTrackToStream = (transceiverName: string, track: MediaStreamTrack) => {
    // the names of the streams that include the transceiver's track
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
        // emit stream event when stream is complete
        this.emit('stream', stream, streamName, this)
      }
    })
  }

  private onTrack = async (e: RTCTrackEvent) => {
    const { track, transceiver } = e
    const transceiverName = Object.keys(this.midLookup).find(
      (name) => this.midLookup[name] === transceiver.mid
    )
    if (transceiverName) {
      this.addTrackToStream(transceiverName, track)
    } else {
      if (!transceiver.mid) throw new Error('No mid in onTrack')
      this.midsWithoutNames.add(transceiver.mid)
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
      case 'midOffer':
        this.midLookup[payload.transceiverName] = payload.mid
        if (this.midsWithoutNames.has(payload.mid)) {
          this.midsWithoutNames.delete(payload.mid)
          const transceiver = this.peerConnection
            .getTransceivers()
            .find(({ mid }) => mid === payload.mid)
          if (!transceiver) throw new Error(`No transceiver exists with mid: ${payload.mid}`)
          this.addTrackToStream(payload.transceiverName, transceiver.receiver.track)
          const { trackConfigOrKind } = this.streamConfig.find(
            ({ transceiverName }) => transceiverName === payload.transceiverName
          )!
          replyWithTrack(transceiver, trackConfigOrKind).catch()
        }
        break
      case 'transceiverRequest':
        if (
          !this.midLookup[payload.transceiverName] &&
          !this.pendingTransceivers.some(
            ({ transceiverName }) => transceiverName === payload.transceiverName
          )
        ) {
          this.setupTransceiver(payload.transceiverName, payload.kind)
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
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      this.dataChannelQueue.push(payload)
    } else {
      try {
        this.dataChannel.send(`@fast/${JSON.stringify(payload)}`)
      } catch (e) {
        this.dataChannelQueue.push(payload)
      }
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

  private setupTransceiver (transceiverName: string, defaultKind: TrackKind = 'video') {
    const { trackConfigOrKind } = this.streamConfig.find(
      (config) => config.transceiverName === transceiverName
    )!
    const trackOrKind =
      typeof trackConfigOrKind === 'string'
        ? trackConfigOrKind
        : trackConfigOrKind
        ? trackConfigOrKind.track
        : defaultKind
    this.negotiationCount++
    const transceiver = this.peerConnection.addTransceiver(trackOrKind)
    this.pendingTransceivers.push({ transceiver, transceiverName })
  }

  private getTransceiver (transceiverName: string) {
    if (!this.peerConnection) return
    const mid = this.midLookup[transceiverName]
    return this.peerConnection.getTransceivers().find((transceiver) => transceiver.mid === mid)
  }

  private setTrack (transceiverName: string, trackConfigOrKind: TrackConfigOrKind) {
    const existingTransceiver = this.getTransceiver(transceiverName)
    if (existingTransceiver) {
      replyWithTrack(existingTransceiver, trackConfigOrKind).catch()
    } else {
      if (this.isOfferer) {
        this.setupTransceiver(transceiverName)
      } else {
        // i don't know if the offerer is going to create the transceiver i want them to
        // let me ask then to create it
        const kind =
          typeof trackConfigOrKind === 'string'
            ? trackConfigOrKind
            : (trackConfigOrKind.track.kind as TrackKind)
        this.sendInternal({ type: 'transceiverRequest', transceiverName, kind })
      }
    }
  }

  private upsertStreamConfig (
    streamName: string,
    transceiverName: string,
    trackConfigOrKind: TrackConfigOrKind | null
  ) {
    const existingConfig = this.streamConfig.find(
      (config) => config.streamName === streamName && config.transceiverName === transceiverName
    )
    if (!existingConfig) {
      this.streamConfig.push({ streamName, transceiverName, trackConfigOrKind })
    } else {
      existingConfig.trackConfigOrKind = trackConfigOrKind
    }
  }

  addStreams = (streams: StreamDict) => {
    // if called after destruction, ignore
    if (!this.peerConnection) return
    Object.keys(streams).forEach((streamName) => {
      const trackDict = streams[streamName]
      const transceiverNames = Object.keys(trackDict)
      this.sendInternal({ type: 'stream', streamName, transceiverNames })
      transceiverNames.forEach((transceiverName) => {
        const trackConfigOrKind = trackDict[transceiverName]
        this.upsertStreamConfig(streamName, transceiverName, trackConfigOrKind)
        if (trackConfigOrKind) {
          this.setTrack(transceiverName, trackConfigOrKind)
        }
      })
    })
  }

  muteTrack (transceiverName: string) {
    const transceiver = this.getTransceiver(transceiverName)
    if (!transceiver) {
      throw new Error(`Invalid track name: ${name}`)
    }
    const { track } = transceiver.sender
    transceiver.sender.replaceTrack(null).catch()
    transceiver.direction = 'recvonly'
    if (track) {
      track.enabled = false
      // HACK CHROME73+: stop() is required to alert the browser that the hardware is not in use
      track.stop()
    }
  }

  close () {
    if (!this.peerConnection) return
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
    // even if the datachannel is open, it may still fail >:-(
    try {
      this.dataChannel?.send(data)
    } catch (e) {
      this.emit('error', e, this)
    }
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
