import * as WebSocket from 'universal-websocket-client';
import { EventEmitter, Listener } from './Toolkit/TypedEventEmitter';
import { PubSubIncomingPacket, PubSubNoncedOutgoingPacket, PubSubOutgoingPacket } from './PubSubPacket';
import { PubSubMessageData } from './Messages/PubSubMessage';
import Logger, { LogLevel } from '@d-fischer/logger';

/**
 * A client for the Twitch PubSub interface.
 */
export default class PubSubClient extends EventEmitter {
	private _socket?: WebSocket;

	private readonly _logger: Logger;

	private _connecting: boolean = false;
	private _connected: boolean = false;
	private _manualDisconnect: boolean = false;
	private _initialConnect: boolean = false;

	private _pingCheckTimer?: NodeJS.Timer;
	private _pingTimeoutTimer?: NodeJS.Timer;
	private _retryTimer?: NodeJS.Timer;
	private _retryDelayGenerator?: IterableIterator<number>;

	private readonly _onPong: (handler: () => void) => Listener = this.registerEvent();
	private readonly _onResponse: (handler: (nonce: string, error: string) => void) => Listener = this.registerEvent();

	/**
	 * Fires when a message that matches your listening topics is received.
	 *
	 * @eventListener
	 * @param topic The name of the topic.
	 * @param message The message data.
	 */
	readonly onMessage: (handler: (topic: string, message: PubSubMessageData) => void) => Listener = this.registerEvent();

	/**
	 * Creates a new PubSub client.
	 *
	 * @param logLevel The level of logging to use for the PubSub client.
	 */
	constructor(logLevel: LogLevel = LogLevel.WARNING) {
		super();
		this._logger = new Logger({
			name: 'twitch-pubsub-client',
			minLevel: logLevel
		});
	}

	/**
	 * Listens to one or more topics.
	 *
	 * @param topics A topic or a list of topics to listen to.
	 * @param accessToken An access token. Only necessary for some topics.
	 */
	async listen(topics: string | string[], accessToken?: string) {
		if (typeof topics === 'string') {
			topics = [topics];
		}

		return this._sendNonced({
			type: 'LISTEN',
			data: {
				topics,
				auth_token: accessToken
			}
		});
	}

	/**
	 * Removes one or more topics from the listener.
	 *
	 * @param topics A topic or a list of topics to not listen to anymore.
	 */
	async unlisten(topics: string | string[]) {
		if (typeof topics === 'string') {
			topics = [topics];
		}

		return this._sendNonced({
			type: 'UNLISTEN',
			data: {
				topics
			}
		});
	}

	private async _sendNonced<T extends PubSubNoncedOutgoingPacket>(packet: T) {
		return new Promise<void>((resolve, reject) => {
			const nonce = Math.random().toString(16).slice(2);

			this._onResponse((recvNonce, error) => {
				if (recvNonce === nonce) {
					if (error) {
						reject(new Error(`Error sending nonced ${packet.type} packet: ${error}`));
					} else {
						resolve();
					}
				}
			});

			packet.nonce = nonce;

			this._sendPacket(packet);
		});
	}

	/**
	 * Connects to the PubSub interface.
	 */
	async connect() {
		return new Promise<void>((resolve, reject) => {
			if (this._connected) {
				resolve();
				return;
			}
			this._connecting = true;
			this._initialConnect = true;
			this._socket = new WebSocket('wss://pubsub-edge.twitch.tv');
			this._socket.on('open', () => {
				this._connected = true;
				this._connecting = false;
				this._initialConnect = false;
				this._retryDelayGenerator = undefined;
				this._startPingCheckTimer();
				resolve();
			});
			this._socket.onmessage = ({ data }: { data: WebSocket.Data }) => {
				this._receiveMessage(data.toString());
			};
			this._socket.onclose = ({ wasClean, code, reason }) => {
				if (this._pingCheckTimer) {
					clearInterval(this._pingCheckTimer);
				}
				if (this._pingTimeoutTimer) {
					clearTimeout(this._pingTimeoutTimer);
				}
				this._socket = undefined;
				this._connected = false;
				this._connecting = false;
				const wasInitialConnect = this._initialConnect;
				this._initialConnect = false;
				if (!wasClean) {
					if (this._manualDisconnect) {
						this._manualDisconnect = false;
					} else {
						// tslint:disable-next-line:no-console
						console.error(`PubSub connection unexpectedly closed: [${code}] ${reason}`);
						if (wasInitialConnect) {
							reject();
						}
						if (!this._retryDelayGenerator) {
							this._retryDelayGenerator = PubSubClient._getReconnectWaitTime();
						}
						const delay = this._retryDelayGenerator.next().value;
						// tslint:disable-next-line:no-console
						console.log(`Reconnecting in ${delay} seconds`);
						this._retryTimer = setTimeout(async () => this.connect(), delay * 1000);
					}
				}
			};
		});
	}

	private _receiveMessage(dataStr: string) {
		this._logger.debug1(`Received message: ${dataStr}`);
		const data: PubSubIncomingPacket = JSON.parse(dataStr);

		switch (data.type) {
			case 'PONG': {
				this.emit(this._onPong);
				break;
			}
			case 'RECONNECT': {
				// tslint:disable-next-line:no-floating-promises
				this._reconnect();
				break;
			}
			case 'RESPONSE': {
				this.emit(this._onResponse, data.nonce, data.error);
				break;
			}
			case 'MESSAGE': {
				this.emit(this.onMessage, data.data.topic, JSON.parse(data.data.message));
				break;
			}
			default: {
				console.warn(`PubSub connection received unexpected message type: ${(data as PubSubIncomingPacket).type}`);
			}
		}
	}

	private _sendPacket(data: PubSubOutgoingPacket) {
		const dataStr = JSON.stringify(data);
		this._logger.debug1(`Sending message: ${dataStr}`);

		if (this._socket && this._connected) {
			this._socket.send(dataStr);
		}
	}

	private _pingCheck() {
		const pongListener = this._onPong(() => {
			if (this._pingTimeoutTimer) {
				clearTimeout(this._pingTimeoutTimer);
			}
			this.removeListener(pongListener);
		});
		this._pingTimeoutTimer = setTimeout(
			async () => {
				this.removeListener(pongListener);
				return this._reconnect();
			},
			10000
		);
		this._sendPacket({ type: 'PING' });
	}

	private _disconnect() {
		if (this._retryTimer) {
			clearInterval(this._retryTimer);
		}
		this._retryDelayGenerator = undefined;
		if (this._socket) {
			this._manualDisconnect = true;
			this._socket.close();
		}
	}

	private async _reconnect() {
		this._disconnect();
		await this.connect();
	}

	/**
	 * Checks whether the client is currently connecting to the server.
	 */
	protected get isConnecting() {
		return this._connecting;
	}

	/**
	 * Checks whether the client is currently connected to the server.
	 */
	protected get isConnected() {
		return this._connected;
	}

	private _startPingCheckTimer() {
		if (this._pingCheckTimer) {
			clearInterval(this._pingCheckTimer);
		}
		this._pingCheckTimer = setInterval(
			() => this._pingCheck(),
			60000
		);
	}

	// yes, this is just fibonacci with a limit
	private static * _getReconnectWaitTime(): IterableIterator<number> {
		let current = 0;
		let next = 1;

		while (current < 120) {
			yield current;
			[current, next] = [next, current + next];
		}

		while (true) {
			yield 120;
		}
	}
}
