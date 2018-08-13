import EventEmitter from 'eventemitter3'
import uuid from 'uuid/v4'

// Payloads
export const OFFER: 'offer' = 'offer'
export const ANSWER: 'answer' = 'answer'
export const CANDIDATE: 'candidate' = 'candidate'

// Events
export const SIGNAL: 'signal' = 'signal'
export const DATA: 'data' = 'data'
export const DATA_OPEN: 'dataOpen' = 'dataOpen'
export const DATA_CLOSE: 'dataClose' = 'dataClose'
export const ERROR: 'error' = 'error'

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

export type DataPayload = string | Blob | ArrayBuffer | ArrayBufferView

export interface PeerConfig extends RTCConfiguration {
  id?: string
  isOfferer?: boolean
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
  candidate: RTCIceCandidateInit
}

export interface AnswerPayload {
  type: 'answer'
  sdp: string
}

export type DispatchPayload = OfferPayload | CandidatePayload | AnswerPayload

class FastRTCPeer extends EventEmitter {
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

  dataChannel?: RTCDataChannel
  id: string
  isOfferer: boolean
  peerConnection!: RTCPeerConnection
  wrtc: WRTC | Window

  constructor (userConfig: PeerConfig) {
    super()
    const { id = uuid(), isOfferer = false, wrtc = window, ...rest }: PeerConfig = userConfig || {}
    this.id = id
    this.isOfferer = isOfferer
    this.wrtc = wrtc
    const peerConnectionConfig = { ...FastRTCPeer.defaultConfig, ...rest }
    this.setup(peerConnectionConfig)
  }

  private setup (config: RTCConfiguration) {
    const peerConnection = (this.peerConnection = new this.wrtc.RTCPeerConnection(config))
    peerConnection.onicecandidate = this.onIceCandidate
    peerConnection.oniceconnectionstatechange = this.onIceConnectionStateChange
    if (this.isOfferer) {
      const channel = this.peerConnection.createDataChannel('fastRTC')
      this.setChannelEvents(channel)
      peerConnection.onnegotiationneeded = this.onNegotiationNeeded
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
    this.emit(DATA, event.data, this)
  }

  private onDataChannelClose = () => {
    this.emit(DATA_CLOSE, this)
  }

  private onDataChannelOpen = () => {
    this.emit(DATA_OPEN, this)
  }

  private onIceCandidate = (event: RTCPeerConnectionIceEvent) => {
    const { candidate } = event
    // if candidate is null, then the trickle is complete
    this.emit(
      SIGNAL,
      {
        type: CANDIDATE,
        candidate
      },
      this
    )
  }

  private onIceConnectionStateChange = () => {
    const { iceConnectionState } = this.peerConnection
    switch (iceConnectionState) {
      case 'closed':
      case 'failed':
      case 'disconnected':
        this.close()
        break
    }
  }

  private onNegotiationNeeded = async () => {
    const offer = await this.peerConnection.createOffer()
    this.emit(SIGNAL, offer, this)
    this.peerConnection.setLocalDescription(offer).catch((e) => this.emit(ERROR, e, this))
  }

  private handleAnswer (initSDP: RTCSessionDescriptionInit) {
    const desc = new this.wrtc.RTCSessionDescription(initSDP) as RTCSessionDescriptionInit
    this.peerConnection.setRemoteDescription(desc).catch((e) => this.emit(ERROR, e, this))
  }

  private handleCandidate (candidateObj: RTCIceCandidateInit) {
    const candidate = new this.wrtc.RTCIceCandidate(candidateObj)
    this.peerConnection.addIceCandidate(candidate).catch((e) => this.emit(ERROR, e, this))
  }

  private handleOffer = async (nitSDP: RTCSessionDescriptionInit) => {
    // typescript defs for RTCSessionDescription should return RTCSessionDescription, not the init
    const sdp = new this.wrtc.RTCSessionDescription(nitSDP) as RTCSessionDescriptionInit
    await this.peerConnection.setRemoteDescription(sdp)
    const answer = await this.peerConnection.createAnswer()
    this.emit(SIGNAL, answer, this)
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
  }

  send = (data: DataPayload) => {
    this.dataChannel!.send(data)
  }

  dispatch (payload: DispatchPayload) {
    switch (payload.type) {
      case OFFER:
        this.handleOffer(payload).catch((e) => this.emit(ERROR, e, this))
        break
      case CANDIDATE:
        this.handleCandidate(payload.candidate)
        break
      case ANSWER:
        this.handleAnswer(payload)
    }
  }
}

export default FastRTCPeer
