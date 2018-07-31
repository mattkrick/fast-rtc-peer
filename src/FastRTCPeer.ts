import EventEmitter from 'eventemitter3'
import uuid from 'uuid/v4'

// Payloads
export const OFFER = 'offer'
export const ANSWER = 'answer'
export const CANDIDATE = 'candidate'

// Events
export const SIGNAL = 'signal'
export const DATA = 'data'
export const DATA_OPEN = 'dataOpen'
export const DATA_CLOSE = 'dataClose'

export interface PeerConfig extends RTCConfiguration {
  id?: string
  isOfferer?: boolean
  wrtc?: WRTC
}

export interface WRTC {
  RTCIceCandidate: typeof RTCIceCandidate
  RTCPeerConnection: RTCPeerConnectionStatic
  RTCSessionDescription: typeof RTCSessionDescription
}

class FastRTCPeer extends EventEmitter {
  static defaultICEServers = [
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

  dataChannel: any
  id: string
  isOfferer: boolean
  peerConnection!: RTCPeerConnection
  wrtc: WRTC

  constructor(userConfig: PeerConfig) {
    super()
    const {
      id = uuid(),
      isOfferer = false,
      wrtc = window,
      ...rest
    }: PeerConfig =
      userConfig || {}
    this.id = id
    this.isOfferer = isOfferer
    this.wrtc = wrtc as any
    const peerConnectionConfig = { ...FastRTCPeer.defaultConfig, ...rest }
    this.setup(peerConnectionConfig)
  }

  private setup(config) {
    const peerConnection = (this.peerConnection = new this.wrtc.RTCPeerConnection(
      config
    ))
    peerConnection.onicecandidate = this.onIceCandidate
    peerConnection.oniceconnectionstatechange = this.onIceConnectionStateChange
    if (this.isOfferer) {
      const channel = this.peerConnection.createDataChannel('fastRTC')
      this.setChannelEvents(channel)
      peerConnection.onnegotiationneeded = this.onNegotiationNeeded
    } else {
      peerConnection.ondatachannel = e => {
        this.setChannelEvents(e.channel)
      }
    }
  }

  private setChannelEvents = channel => {
    channel.onmessage = this.onDataChannelMessage
    channel.onopen = this.onDataChannelOpen
    channel.onclose = this.onDataChannelClose
    this.dataChannel = channel
  }

  private onDataChannelMessage = event => {
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
    if (!candidate) return
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
    this.peerConnection.setLocalDescription(offer)
  }

  private handleAnswer(sdpStr) {
    const sdp = new this.wrtc.RTCSessionDescription(sdpStr) as any
    this.peerConnection.setRemoteDescription(sdp)
  }

  private handleCandidate(candidateObj) {
    const candidate = new this.wrtc.RTCIceCandidate(candidateObj)
    this.peerConnection.addIceCandidate(candidate)
  }

  private handleOffer = async sdpMessage => {
    const sdp = new this.wrtc.RTCSessionDescription(sdpMessage) as any
    await this.peerConnection.setRemoteDescription(sdp)
    const answer = await this.peerConnection.createAnswer()
    this.emit(SIGNAL, answer, this)
    this.peerConnection.setLocalDescription(answer)
  }

  close() {
    this.peerConnection.close()
    this.peerConnection.onicecandidate = null
    this.peerConnection.oniceconnectionstatechange = null
    this.peerConnection.onnegotiationneeded = null
  }

  send = data => {
    this.dataChannel.send(data)
  }

  dispatch(payload) {
    const { candidate, sdp, type } = payload
    switch (type) {
      case OFFER:
        this.handleOffer({ type, sdp })
        break
      case CANDIDATE:
        this.handleCandidate(candidate)
        break
      case ANSWER:
        this.handleAnswer({ type, sdp })
    }
  }
}

export default FastRTCPeer
