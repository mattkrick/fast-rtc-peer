# fast-rtc-peer

a small RTC client for connecting 2 peers

## Installation

`yarn add @mattkrick/fast-rtc-peer`

## Why

WebRTC is great, but navigating the handshake includes a lot of boilerplate.
Most libraries out there were written years ago before WebRTC hit v1.0.
The libraries that do support v1.0 don't support advanced features like [transceiver warm-up](https://w3c.github.io/webrtc-pc/#advanced-peer-to-peer-example-with-warm-up).
As a result, they can be slow and a little bloated.
The goal of this library is to be fast, small, and easy to understand.
It's built using the lowest level API, so it supports all kinds of media transceiver patterns.

## High level architecture

When a peer in created, a TCP-like datachannel is set up.
To enable media warm-up, `addTransceiver` is used instead of `addTrack`.
This results in faster video set up.
To eliminate race conditions (e.g. the offerer and answerer calling `addTransceiver` at the same time),
only the offerer can create a transceiver. The answerer must ask the offerer to create it.
The extra behind-the-scenes step guarantees a deterministic, user-defined name for each transceiver and stream, 
which allows for simpler, structured API, e.g. `muteTrack('webcamVideo')`.

## FAQ

### Can I connect more than 2 peers?

Yes! Just use [fast-rtc-swarm](https://github.com/mattkrick/fast-rtc-swarm)

### Does it support older clients/protocols?

Yes! Just use [adapter](https://github.com/webrtc/adapter).

### Does it support multiple data channels?

Yes! Just use the underlying RTCConnection: `peer.peerConnection.createDataChannel('channel2')`

### Does it support audio/video?

Yes! It applies the `unified-plan` semantics by default.

### How do I implement warm-up?
Instead of passing in a track, pass in the `kind` ("audio" or "video")

## Usage

```js
import FastRTCPeer from '@mattkrick/fast-rtc-peer'

const cam = await navigator.mediaDevices.getUserMedia({video: true, audio: true})
const localPeer = new FastRTCPeer({isOfferer: true, streams: {cam}})

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
  // all tracks that belong to the stream have been received!
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
- `streams`: an object where the key in the name of the stream & the value is either a `MediaStream` or an object with named tracks. See the typings.

Static Methods
- `defaultICEServers`: a list of default STUN servers.
In production, you'll want to add a list of TURN servers to this if peers are behind symmetrical NATs.
An instantiation may look like this: `new FastRTCPeer({iceServers: [...FastRTCPeer.defaultIceServers, myTURNServer]})`

Methods
- `dispatch(signal)`: receive an incoming signal from the signal server
- `send(message)`: send a string or buffer to the peer.
- `close()`: destroy the connection
- `addStreams(streamDict)`: add a new stream. See StreamDict typings for more info.
- `muteTrack(trackName)`: mute an audio or video track

## Events

- `peer.on('open', (peer) => {})`: fired when a peer connection opens
- `peer.on('close', (peer) => {})`: fired when a peer disconnects (does not fire for the peer that called `peer.close()`) 
- `peer.on('data', (data, peer) => {})`: fired when a peer sends data
- `peer.on('error', (error, peer) => {})`: fired when an error occurs in the signaling process
- `peer.on('stream', (stream, peer) => {})`: fired when all the tracks of a remote stream have started.
- `peer.on('connection', (state, peer) => {})`: fired when the ice connection state changes. Useful for notifying the viewer about connectivity issues.
- `peer.on('signal', (signal, peer) => {})`: fired when a peer creates an offer, ICE candidate, or answer.
Don't worry about what that means. Just forward it to the remote client & have them call `dispatch(signal)`.

## License

MIT
