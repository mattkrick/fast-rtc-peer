import EventEmitter from 'eventemitter3'
import shortid from 'shortid'
import StrictEventEmitter from 'strict-event-emitter-types'

// hacks to get around the errors in lib.dom.d
declare global {
  interface Window {
    RTCIceCandidate: typeof RTCIceCandidate
    RTCPeerConnection: typeof RTCPeerConnection
    RTCSessionDescription: typeof RTCSessionDescription
  }

  interface RTCDataChannel {
    send (data: DataPayload): void
  }
}

export type PayloadToServer = CandidatePayload | RTCSessionDescriptionInit

export interface FastRTCPeerEvents {
  signal: (payload: PayloadToServer, peer: FastRTCPeer) => void
  data: (data: DataPayload, peer: FastRTCPeer) => void
  dataOpen: (peer: FastRTCPeer) => void
  dataClose: (peer: FastRTCPeer) => void
  error: (error: Error, peer: FastRTCPeer) => void
  onTrack: (event: RTCTrackEvent, peer: FastRTCPeer) => void
  stream: (stream: MediaStream | null, peer: FastRTCPeer) => void
}

export type DataPayload = string | Blob | ArrayBuffer | ArrayBufferView

export interface PeerConfig extends RTCConfiguration {
  id?: string
  isOfferer?: boolean
  audio?: RTCRtpTransceiverInit
  video?: RTCRtpTransceiverInit
  wrtc?: WRTC
}

export interface WRTC {
  RTCIceCandidate: typeof RTCIceCandidate
  RTCPeerConnection: typeof RTCPeerConnection
  RTCSessionDescription: typeof RTCSessionDescription
}

export interface OfferPayload {
  type: 'offer'
  sdp: string
}

export interface CandidatePayload {
  type: 'candidate'
  candidate: RTCIceCandidateInit | null
}

export interface AnswerPayload {
  type: 'answer'
  sdp: string
}

export type PayloadFromServer = OfferPayload | CandidatePayload | AnswerPayload

export type FastRTCPeerEmitter = {new (): StrictEventEmitter<EventEmitter, FastRTCPeerEvents>}

export type TrackKind = 'audio' | 'video'
// Try again later when all of these exist in lib
// export type ICEError = TypeError | InvalidStateError | OperationError

const getTrack = (streams: Array<MediaStream> | undefined, kind: TrackKind) => {
  if (!streams || !streams[0]) return
  const method = kind === 'audio' ? 'getAudioTracks' : 'getVideoTracks'
  return streams[0][method]()[0]
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
    iceServers: FastRTCPeer.defaultICEServers
  }

  static generateID = () => {
    return shortid.generate()
  }

  dataChannel?: RTCDataChannel
  id: string
  isOfferer: boolean
  peerConnection!: RTCPeerConnection
  audioConfig?: RTCRtpTransceiverInit
  videoConfig?: RTCRtpTransceiverInit
  wrtc: WRTC | Window
  stream?: MediaStream

  constructor (userConfig: PeerConfig = {}) {
    super()
    const {
      audio,
      id = FastRTCPeer.generateID(),
      isOfferer = false,
      video,
      wrtc = window,
      ...rest
    } = userConfig
    this.id = id
    this.isOfferer = isOfferer
    this.wrtc = wrtc
    this.audioConfig = audio
    const peerConnectionConfig = { ...FastRTCPeer.defaultConfig, ...rest }
    this.setupData(peerConnectionConfig)
    this.peerConnection.ontrack = this.onTrack
    this.setupVideo(video)
    this.setupAudio(audio)
  }

  setupVideo = (videoConfig?: RTCRtpTransceiverInit) => {
    this.videoConfig = videoConfig
    this.setupTransceiver(videoConfig, 'video')
  }

  setupAudio = (audioConfig?: RTCRtpTransceiverInit) => {
    this.audioConfig = audioConfig
    this.setupTransceiver(audioConfig, 'audio')
  }

  onTrack = async (e: RTCTrackEvent) => {
    if (this.isOfferer) {
      if (this.stream) {
        this.stream.addTrack(e.track)
      } else {
        // `replaceTrack` doesn't link to a stream & setStream isn't available yet, so we manage our own
        this.stream = new MediaStream([e.track])
      }
    } else {
      const {
        streams,
        track: { kind }
      } = e
      this.stream = streams[0] || null
      await this.replyWithMedia(e.transceiver, kind as TrackKind)
    }
    this.emit('stream', this.stream, this)
    this.emit('onTrack', e, this)
  }

  private replyWithMedia = async (transceiver: RTCRtpTransceiver, kind: TrackKind) => {
    const config = kind === 'audio' ? this.audioConfig : this.videoConfig
    const track = getTrack(config && config.streams, kind as TrackKind)
    if (track) {
      await transceiver.sender.replaceTrack(track)
      transceiver.direction = 'sendrecv'
    }
  }

  private setupTransceiver = (config: RTCRtpTransceiverInit | undefined, kind: TrackKind) => {
    if (!config) return
    if (this.isOfferer) {
      const trackOrKind = getTrack(config.streams, kind) || kind
      this.peerConnection.addTransceiver(trackOrKind, config)
    }
  }

  private setupData (config: RTCConfiguration) {
    const peerConnection = (this.peerConnection = new this.wrtc.RTCPeerConnection(config))
    peerConnection.onicecandidate = this.onIceCandidate
    peerConnection.oniceconnectionstatechange = this.onIceConnectionStateChange
    peerConnection.onnegotiationneeded = this.onNegotiationNeeded
    if (this.isOfferer) {
      const channel = this.peerConnection.createDataChannel('fastRTC')
      this.setChannelEvents(channel)
    } else {
      peerConnection.ondatachannel = (e) => {
        this.setChannelEvents(e.channel)
      }
    }
  }

  private setChannelEvents = (channel: RTCDataChannel) => {
    channel.onmessage = this.onDataChannelMessage
    channel.onopen = this.onDataChannelOpen
    channel.onclose = this.onDataChannelClose
    this.dataChannel = channel
  }

  private onDataChannelMessage = (event: MessageEvent) => {
    this.emit('data', event.data, this)
  }

  private onDataChannelClose = () => {
    this.emit('dataClose', this)
  }

  private onDataChannelOpen = () => {
    this.emit('dataOpen', this)
  }

  private onIceCandidate = (event: RTCPeerConnectionIceEvent) => {
    // if candidate is null, then the trickle is complete
    this.emit(
      'signal',
      {
        type: 'candidate',
        // hack for strict-event-emitter-types
        candidate: event.candidate as any
      },
      this
    )
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
  }

  private onNegotiationNeeded = async () => {
    const offer = await this.peerConnection.createOffer()
    this.emit('signal', offer, this)
    this.peerConnection.setLocalDescription(offer).catch((e: Error) => this.emit('error', e, this))
  }

  private handleAnswer (initSDP: RTCSessionDescriptionInit) {
    const desc = new this.wrtc.RTCSessionDescription(initSDP) as RTCSessionDescriptionInit
    this.peerConnection.setRemoteDescription(desc).catch((e: Error) => this.emit('error', e, this))
  }

  private handleCandidate (candidateObj: RTCIceCandidateInit | null) {
    if (!candidateObj) return
    const candidate = new this.wrtc.RTCIceCandidate(candidateObj)
    this.peerConnection.addIceCandidate(candidate).catch((e: Error) => this.emit('error', e, this))
  }

  private handleOffer = async (initSDP: RTCSessionDescriptionInit) => {
    // typescript defs for RTCSessionDescription should return RTCSessionDescription, not the init
    const sdp = new this.wrtc.RTCSessionDescription(initSDP) as RTCSessionDescriptionInit
    await this.peerConnection.setRemoteDescription(sdp)
    const answer = await this.peerConnection.createAnswer()
    this.emit('signal', answer, this)
    await this.peerConnection.setLocalDescription(answer)
  }

  async addMedia (mediaConstraints: MediaStreamConstraints) {
    const { navigator } = this.wrtc as any
    if (!navigator) return
    const stream = await window.navigator.mediaDevices.getUserMedia(mediaConstraints)
    const tracks = stream.getTracks()
    tracks.forEach((track) => this.peerConnection.addTrack(track, stream))
  }

  close () {
    this.peerConnection.close()
    this.peerConnection.onicecandidate = null
    this.peerConnection.oniceconnectionstatechange = null
    this.peerConnection.onnegotiationneeded = null
    this.peerConnection.ondatachannel = null
    this.peerConnection.ontrack = null
  }

  send = (data: DataPayload) => {
    this.dataChannel!.send(data)
  }

  dispatch (payload: PayloadFromServer) {
    switch (payload.type) {
      case 'offer':
        this.handleOffer(payload).catch((e: Error) => this.emit('error', e, this))
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
