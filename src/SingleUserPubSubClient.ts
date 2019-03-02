import TwitchClient, { RefreshableAuthProvider } from 'twitch';
import BasicPubSubClient from './BasicPubSubClient';
import { NonEnumerable } from './Toolkit/Decorators';
import PubSubListener from './PubSubListener';
import PubSubBitsMessage, { PubSubBitsMessageData } from './Messages/PubSubBitsMessage';
import PubSubSubscriptionMessage, { PubSubSubscriptionMessageData } from './Messages/PubSubSubscriptionMessage';
import PubSubCommerceMessage, { PubSubCommerceMessageData } from './Messages/PubSubCommerceMessage';
import PubSubWhisperMessage, { PubSubWhisperMessageData } from './Messages/PubSubWhisperMessage';
import PubSubMessage from './Messages/PubSubMessage';
import { LogLevel } from '@d-fischer/logger';

/**
 * A higher level PubSub client attached to a single user.
 */
export default class SingleUserPubSubClient {
	@NonEnumerable private readonly _twitchClient: TwitchClient;
	@NonEnumerable private readonly _pubSubClient: BasicPubSubClient;

	private readonly _listeners: Map<string, PubSubListener[]> = new Map;

	/**
	 * Creates a new Twitch PubSub client.
	 *
	 * @param twitchClient The {@TwitchClient} instance to use for API requests.
	 * @param pubSubClient The underlying {@BasicPubSubClient} instance. If not given, we'll create a new one.
	 * @param logLevel The level of logging to use for the PubSub client.
	 */
	constructor(twitchClient: TwitchClient, pubSubClient?: BasicPubSubClient, logLevel: LogLevel = LogLevel.WARNING) {
		this._twitchClient = twitchClient;
		this._pubSubClient = pubSubClient || new BasicPubSubClient(logLevel);
		this._pubSubClient.onMessage((topic, messageData) => {
			const [type] = topic.split('.');
			if (this._listeners.has(type)) {
				let message: PubSubMessage;
				switch (type) {
					case 'channel-bits-events-v1': {
						message = new PubSubBitsMessage(messageData as PubSubBitsMessageData, this._twitchClient);
						break;
					}
					case 'channel-subscribe-events-v1': {
						message = new PubSubSubscriptionMessage(messageData as PubSubSubscriptionMessageData, this._twitchClient);
						break;
					}
					case 'channel-commerce-events-v1': {
						message = new PubSubCommerceMessage(messageData as PubSubCommerceMessageData, this._twitchClient);
						break;
					}
					case 'whispers': {
						message = new PubSubWhisperMessage(messageData as PubSubWhisperMessageData, this._twitchClient);
						break;
					}
					default:
						return;
				}
				for (const listener of this._listeners.get(type)!) {
					listener.call(message);
				}
			}
		});
	}

	private async _getUserData(scope?: string) {
		let accessToken = await this._twitchClient._config.authProvider.getAccessToken(scope);
		let tokenInfo = await this._twitchClient.getTokenInfo();

		if (!tokenInfo.valid && this._twitchClient._config.authProvider instanceof RefreshableAuthProvider) {
			accessToken = (await this._twitchClient._config.authProvider.refresh()).accessToken;
			tokenInfo = await this._twitchClient.getTokenInfo();
		}
		if (!tokenInfo.valid) {
			throw new Error('PubSub authentication failed');
		}

		const userId = tokenInfo.userId!;

		return { userId, accessToken };
	}

	private async _addListener<T extends PubSubMessage>(type: string, callback: (message: T) => void, scope?: string) {
		await this._pubSubClient.connect();
		const { userId, accessToken } = await this._getUserData(scope);
		const listener = new PubSubListener(type, userId, callback, this);
		if (this._listeners.has(type)) {
			this._listeners.get(type)!.push(listener);
		} else {
			this._listeners.set(type, [listener]);
			await this._pubSubClient.listen(`${type}.${userId}`, accessToken);
		}
		return listener;
	}

	/**
	 * Adds a listener to bits events to the client.
	 *
	 * @param callback A function to be called when a bits event happens in the user's channel.
	 *
	 * It receives a {@PubSubBitsMessage} object.
	 */
	async onBits(callback: (message: PubSubBitsMessage) => void) {
		return this._addListener('channel-bits-events-v1', callback);
	}

	/**
	 * Adds a listener to subscription events to the client.
	 *
	 * @param callback A function to be called when a subscription event happens in the user's channel.
	 *
	 * It receives a {@PubSubSubscriptionMessage} object.
	 */
	async onSubscription(callback: (message: PubSubSubscriptionMessage) => void) {
		return this._addListener('channel-subscribe-events-v1', callback, 'channel_subscriptions');
	}

	/**
	 * Adds a listener to commerce events to the client.
	 *
	 * @param callback A function to be called when a commerce event happens in the user's channel.
	 *
	 * It receives a {@PubSubCommerceMessage} object.
	 */
	async onCommerce(callback: (message: PubSubCommerceMessage) => void) {
		return this._addListener('channel-commerce-events-v1', callback);
	}

	/**
	 * Adds a listener to whisper events to the client.
	 *
	 * @param callback A function to be called when a whisper event is sent to the user.
	 *
	 * It receives a {@PubSubWhisperMessage} object.
	 */
	async onWhisper(callback: (message: PubSubWhisperMessage) => void) {
		return this._addListener('whispers', callback, 'chat_login');
	}

	/**
	 * Removes a listener from the client.
	 *
	 * @param listener A listener returned by one of the `add*Listener` methods.
	 */
	removeListener(listener: PubSubListener) {
		if (this._listeners.has(listener.type)) {
			const newListeners = this._listeners.get(listener.type)!.filter(l => l !== listener);
			if (newListeners.length === 0) {
				this._listeners.delete(listener.type);
				// tslint:disable-next-line:no-floating-promises
				this._pubSubClient.unlisten(`${listener.type}.${listener.userId}`);
			} else {
				this._listeners.set(listener.type, newListeners);
			}
		}
	}
}
