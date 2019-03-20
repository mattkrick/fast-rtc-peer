# fast-rtc-peer

a small RTC client for connecting 2 peers

## Installation

`yarn add @mattkrick/fast-rtc-peer`

## Why

WebRTC is great, but navigating the handshake includes a lot of boilerplate.
Most libraries out there were written years ago before WebRTC hit v1.0.
As a result, they can slow and a little bloated.
The goal of this library is to be fast, small, and easy to understand.
It's built using the lowest level API, so there are no bug mitigation patterns required.

## FAQ

### Can I connect more than 2 peers?

Yes! Just use [fast-rtc-swarm](https://github.com/mattkrick/fast-rtc-swarm)

### Does it support older clients/protocols?

Yes! Just use [adapter](https://github.com/webrtc/adapter).

### Does it support multiple data channels?

Yes! Just use the underlying RTCConnection: `peer.peerConnection.createDataChannel('channel2')`

### Does it support audio/video?

Yes! It applies the `unified-plan` semantics by default.

## Usage

```js
import FastRTCPeer from '@mattkrick/fast-rtc-peer'

const streams = [await navigator.mediaDevices.getUserMedia({video: true, audio: true})]
const audio = {streams}
const video = {streams, sendEncodings: [{rid: 'full'},{rid: 'half', scaleResolutionDownBy: 2.0}]}

const localPeer = new FastRTCPeer({isOfferer: true, audio, video})

// handle outgoing signals
localPeer.on('signal', (payload) => {
  socket.send(JSON.stringify(payload))
})

// handle incoming signals
socket.addEventListener('message', (event) => {
  const payload = JSON.parse(event.data)
  localPeer.dispatch(payload)
})

// handle events
localPeer.on('open', (peer) => {
  console.log('connected & ready to send and receive data!', peer)
  peer.send(JSON.stringify('Hello from', peer.id))
})
localPeer.on('close', (peer) => {
  console.log('disconnected from peer!', peer)
})
localPeer.on('data', (data, peer) => {
  console.log(`got message ${data} from ${peer.id}`)
})

localPeer.on('stream', (stream) => {
  const el = document.getElementById('video')
  el.srcObject = stream
})

// ON THE REMOTE CLIENT
const remotePeer = new FastRTCPeer()
remotePeer.on('signal', (payload) => {
  socket.send(JSON.stringify(payload))
})
remotePeer.on('data', (data, peer) => {
  console.log(`got message ${data} from ${peer.id}`)
})
```

## API

```js
FastRTCPeer(options)
```
Options: A superset of `RTCConfiguration`
- `isOfferer`: true if this client will be sending an offer, falsy if the client will be receiving the offer.
- `id`: Connection ID. An ID to assign to the peer connection, defaults to a v4 uuid
- `userId`: An ID to attach to the user, if known. Defaults to null. Probably won't know this until connection is established.
- `wrtc`: pass in [node-webrtc](https://github.com/js-platform/node-webrtc) if using server side
- `audio`: transceiver config containing the following options:
  - `streams`: an array of streams, eg `[await navigator.mediaDevices.getUserMedia({video: true, audio: true})]`
  - `direction`: (advanced use only)
  - `sendEncodings`: (advanced use only)
- `video`: transceiver config, see above

Static Methods
- `defaultICEServers`: a list of default STUN servers.
In production, you'll want to add a list of TURN servers to this if peers are behind symmetrical NATs.
An instantiation may look like this: `new FastRTCPeer({iceServers: [...FastRTCPeer.defaultIceServers, myTURNServer]})`

Methods
- `dispatch(signal)`: receive an incoming signal from the signal server
- `send(message)`: send a string or buffer to the peer.
- `close()`: destroy the connection
- `setupVideo(transceiverConfig)`: add a video channel, identical to `video` in the Constructor
- `setupAUdio(transceiverConfig)`: add a audio channel, identical to `audio` in the Constructor

## Events

- `peer.on('open', (peer) => {})`: fired when a peer connection opens
- `peer.on('close', (peer) => {})`: fired when a peer disconnects (does not fire for the peer that called `peer.close()`) 
- `peer.on('data', (data, peer) => {})`: fired when a peer sends data
- `peer.on('error', (error, peer) => {})`: fired when an error occurs in the signaling process
- `peer.on('stream', (stream, peer) => {})`: fired when a stream has been created or modified
- `peer.on('onTrack', (RTCTrackEvent, peer) => {})`: native `onTrack` event. Used internally. You probably want to use `stream`
- `peer.on('signal', (signal, peer) => {})`: fired when a peer creates an offer, ICE candidate, or answer.
Don't worry about what that means. Just forward it to the remote client & have them call `dispatch(signal)`.

## License

MIT
