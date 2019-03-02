import SingleUserPubSubClient from './SingleUserPubSubClient';
import BasicPubSubClient from './BasicPubSubClient';
import TwitchClient from 'twitch';
import PubSubBitsMessage from './Messages/PubSubBitsMessage';
import PubSubSubscriptionMessage from './Messages/PubSubSubscriptionMessage';
import PubSubCommerceMessage from './Messages/PubSubCommerceMessage';
import PubSubWhisperMessage from './Messages/PubSubWhisperMessage';

export default class PubSubClient {
	private _rootClient = new BasicPubSubClient();
	private _userClients = new Map<string, SingleUserPubSubClient>();

	async registerClient(twitchClient: TwitchClient) {
		const tokenInfo = await twitchClient.getTokenInfo();
		const userId = tokenInfo.userId!;

		this._userClients.set(userId, new SingleUserPubSubClient(twitchClient, this._rootClient));
	}

	getUserListener(userId: string) {
		if (!this._userClients.has(userId)) {
			throw new Error(`No Twitch client registered for user ID ${userId}`);
		}
		return this._userClients.get(userId)!;
	}

	onBits(userId: string, callback: (message: PubSubBitsMessage) => void) {
		return this.getUserListener(userId).onBits(callback);
	}

	onSubscription(userId: string, callback: (message: PubSubSubscriptionMessage) => void) {
		return this.getUserListener(userId).onSubscription(callback);
	}

	onCommerce(userId: string, callback: (message: PubSubCommerceMessage) => void) {
		return this.getUserListener(userId).onCommerce(callback);
	}

	onWhisper(userId: string, callback: (message: PubSubWhisperMessage) => void) {
		return this.getUserListener(userId).onWhisper(callback);
	}
}
