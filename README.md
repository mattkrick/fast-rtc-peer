# fast-rtc-peer

a small RTC client for connecting 2 peers

## Installation

`yarn add @mattkrick/fast-rtc-peer`

## Why

WebRTC is great, but navigating the handshake includes a lot of boilerplate.
Most libraries out there were written years ago before WebRTC hit v1.0.
As a result, they can slow and a little bloated.
The goal of this library is to be fast, small, and easy to understand.

## FAQ

### Can I connect more than 2 peers?

Yes! Just use [fast-rtc-swarm](https://github.com/mattkrick/fast-rtc-swarm)

### Does it support older clients/protocols?

Yes! Just use [adapter](https://github.com/webrtc/adapter).

### Does it support multiple data channels?

Yes! Just use the underlying RTCConnection: `peer.peerConnection.createDataChannel('channel2')`

### Does it support audio/video?

Yes, but you have to use the low-level API.
Now that WebRTC Stage 3 is finalized & pretty great, I'm open to writing a wrapper around it.
Open an issue to discuss what that API should look like.

## Usage

```js
import FastRTCPeer, {SIGNAL, DATA, DATA_OPEN, DATA_CLOSE} from '@mattkrick/fast-rtc-peer'

const localPeer = new FastRTCPeer({isOfferer: true})

// handle outgoing signals
localPeer.on(SIGNAL, (payload) => {
  socket.send(JSON.stringify(payload))
})

// handle incoming signals
socket.addEventListener('message', (event) => {
  const payload = JSON.parse(event.data)
  localPeer.dispatch(payload)
})

// handle events
localPeer.on(DATA_OPEN, (peer) => {
  console.log('connected & ready to send and receive data!', peer)
  peer.send(JSON.stringify('Hello from', peer.id))
})
localPeer.on(DATA_CLOSE, (peer) => {
  console.log('disconnected from peer!', peer)
})
localPeer.on(DATA, (data, peer) => {
  console.log(`got message ${data} from ${peer.id}`)
})

// ON THE REMOTE CLIENT
const remotePeer = new FastRTCPeer()
remotePeer.on(SIGNAL, (payload) => {
  socket.send(JSON.stringify(payload))
})
remotePeer.on(DATA, (data, peer) => {
  console.log(`got message ${data} from ${peer.id}`)
})
```

## API

```js
FastRTCPeer(options)
```
Options: A superset of `RTCConfiguration`
- `isOfferer`: true if this client will be sending an offer, falsy if the client will be receiving the offer.
- `id`: An ID to assign to the peer, defaults to a v4 uuid
- `wrtc`: pass in [node-webrtc](https://github.com/js-platform/node-webrtc) if using server side

Static Methods
- `defaultICEServers`: a list of default STUN servers.
In production, you'll want to add a list of TURN servers to this if peers are behind symmetrical NATs.
An instantiation may look like this: `new FastRTCPeer({iceServers: [...FastRTCPeer.defaultIceServers, myTURNServer]})`

Methods
- `dispatch(signal)`: receive an incoming signal from the signal server
- `send(message)`: send a string or buffer to the peer.
- `close()`: destroy the connection

## Events

- `peer.on(DATA_OPEN, (peer) => {})`: fired when a peer connects
- `peer.on(DATA_CLOSE, (peer) => {})`: fired when a peer disconnects
- `peer.on(DATA, (data, peer) => {})`: fired when a peer sends data
- `peer.on(ERROR, (error, peer) => {})`: fired when an error occurs in the signaling process
- `peer.on(SIGNAL, (signal, peer) => {})`: fired when a peer creates an offer, ICE candidate, or answer.
Don't worry about what that means. Just forward it to the remote client & have them call `dispatch(signal)`.

## License

MIT
