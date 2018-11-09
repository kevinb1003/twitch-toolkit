'use strict';

const request = require('request-promise');
const util = require('util');
const eventemitter = require('eventemitter3');
const _ = require('./helpers');
const logger = require('./logger').getLogger();

const API_BASE_URL = 'https://api.twitch.tv/helix';

/**
 * @class TwitchWebhook
 * The Twitch Webhooks implementation, as described in https://dev.twitch.tv/docs/api/webhooks-guide/ .
 * The Webhook requires a public endpoint on the running express server/application to receive the data from the hub. Without this, its impossible to make this work.
 *
 * @param {object} config The config object.
 * @param {string} config.clientId The client ID of the user to be passed to the Hub (un)subscribe requests. This is required.
 * @param {string} config.callbackUrl The callback URL that will receive the Hub requests. These requests should be forwarded to the handleRequest method to properly handle these data. This is required.
 * @param {object} config.logger The logger object.
 */
function TwitchWebhook(config) {
    eventemitter.call(this);
    this.config = config;
    this.logger = config.logger || logger;

    this.secret = _.uuidv4();
    this.subscribersMap = new Map();
}

/**
 * Notifies when a follows event occurs. The response mimics the Get Users Follows endpoint. (https://dev.twitch.tv/docs/api/reference/#get-users-follows)
 *
 * @param {number} fromId The ID of the user who starts following someone.
 * @param {number} toId The ID of the user who has a new follower.
 * @return {string} The subscription ID, used to identify the active topic.
 * @fires TwitchWebhook#Webhook:user_follows
 */
TwitchWebhook.prototype.topicUserFollowsSubscribe = async function(
    fromId,
    toId
) {
    /**
     * Stream User Follows Event
     * @event TwitchWebhook#Webhook:user_follows
     * @param {object} data The data object received from the Hub.
     * @param {string} id The subscription ID.
     */
    try {
        let topic = API_BASE_URL + '/users/follows?first=1';
        if (fromId) {
            topic += '&from_id=' + fromId;
        } else if (toId) {
            topic += '&to_id=' + toId;
        }
        return await this.subscribe(topic, 'user_follows');
    } catch (err) {
        throw err;
    }
};

/**
 * Notifies when a stream goes online or offline. The response mimics the Get Streams endpoint. (https://dev.twitch.tv/docs/api/reference/#get-streams)
 *
 * @param {number} streamUserId The ID of the user whose stream is monitored.
 * @return {string} The subscription ID, used to identify the active topic.
 * @fires TwitchWebhook#Webhook:stream_up_down
 */
TwitchWebhook.prototype.topicStreamUpDownSubscribe = async function(
    streamUserId
) {
    /**
     * Stream Up/Down Event
     * @event TwitchWebhook#Webhook:stream_up_down
     * @param {object} data The data object received from the Hub.
     * @param {string} id The subscription ID.
     */
    try {
        let topic = API_BASE_URL + '/streams?user_id=' + streamUserId;
        return await this.subscribe(topic, 'stream_up_down');
    } catch (err) {
        throw err;
    }
};

/**
 * Subscribe to a specific topic that will fires an event when new data is received from the hub.
 * The event handler will receive the data object and the subscription ID.
 * @param {string} topic The topic name/URL.
 * @param {string} eventName The event name that will be fired when new data is received.
 * @return {string} The subscription ID, used to identify the active topic.
 */
TwitchWebhook.prototype.subscribe = async function(topic, eventName) {
    try {
        this.logger.debug('Subscribing Webhook with topic: ' + topic);
        let item = {
            id: _.uuidv4(),
            topic: topic,
            eventName: eventName,
            subscribedAt: new Date(),
            secret: _.generateRandomKey()
        };

        await request({
            url: API_BASE_URL + '/webhooks/hub',
            method: 'POST',
            headers: {
                'Client-ID': this.config.clientId,
                'Content-Type': 'application/json'
            },
            form: {
                'hub.callback': this.config.callbackUrl + '?item.id=' + item.id,
                'hub.mode': 'subscribe',
                'hub.topic': topic,
                'hub.lease_seconds': 864000,
                'hub.secret': item.secret
            },
            json: true
        });

        this.subscribersMap.set(item.id, item);
        return item.id;
    } catch (err) {
        throw err;
    }
};

/**
 * This method will handle the request data and validate the subscriptions or properly emit the events with the received data.
 * @param {string} method The http method
 * @param {string[]} headers The headers array
 * @param {string[]} qs The request query string array. Used for GET and POST
 * @param {string[]} body The POST body. Used just for post.
 * @returns {object} The response result object with the status and data to be sent in the response.
 */
TwitchWebhook.prototype.handleRequest = function(method, headers, qs, body) {
    this.logger.debug('Handling new Webhook request');
    if (!method) throw new Error('Missing method parameter');
    if (!headers) throw new Error('Missing headers parameter');
    if (!qs) throw new Error('Missing qs Parameter');

    if (method.toUpperCase() === 'GET') {
        if (qs['hub.mode'] === 'denied') {
            throw new Error(
                `Hub subscription denied. Reason: ${qs['hub.reason']}`
            );
        }
        if (qs['hub.challenge']) {
            return {
                status: 200,
                data: qs['hub.challenge']
            };
        } else {
            throw new Error('Missing the hub.challenge parameter');
        }
    } else if (method.toUpperCase() === 'POST') {
        if (!body) throw new Error('Missing body Parameter');
        let id = qs['item.id'];
        let signature = headers['x-hub-signature'];

        if (id && this.subscribersMap.get(id)) {
            let item = this.subscribersMap.get(id);
            if (
                _.validateHMACSignature(
                    signature,
                    'sha256',
                    item.secret,
                    JSON.stringify(body)
                )
            ) {
                this.emit(item.eventName, body.data, id);
                return { status: 200 };
            } else {
                return { status: 403 };
            }
        } else {
            return { status: 410 };
        }
    } else {
        throw new Error('Invalid method ' + method);
    }
};

/**
 * Unsubscribe from a topic by its ID.
 * @param {string} id The subscription ID.
 */
TwitchWebhook.prototype.unsubscribe = async function(id) {
    try {
        this.logger.debug('Requesting Webhook unsubscription with id: ' + id);
        if (this.subscribersMap.get(id)) {
            let item = this.subscribersMap.get(id);
            await request({
                url: API_BASE_URL + '/webhooks/hub',
                method: 'POST',
                headers: {
                    'Client-ID': this.config.clientId,
                    'Content-Type': 'application/json'
                },
                form: {
                    'hub.callback':
                        this.config.callbackUrl + '?item.id=' + item.id,
                    'hub.mode': 'unsubscribe',
                    'hub.topic': item.topic,
                    'hub.secret': item.secret
                },
                json: true
            });
            this.logger.debug('Webhook unsubscribed: ' + id);
        } else {
            this.logger.warn('Unable to find subscription with id ' + id);
        }
    } catch (err) {
        throw err;
    }
};

/**
 * Destroy the Webhook, unsubscribing every active subscription.
 */
TwitchWebhook.prototype.destroy = async function() {
    try {
        this.logger.info('Destroying TwitchWebhook...');
        for (let [key, item] of this.subscribersMap) {
            await this.unsubscribe(item.id);
        }
        this.subscribersMap = new Map();
        this.logger.info('TwitchWebhook destroyed.');
    } catch (err) {
        throw err;
    }
};

util.inherits(TwitchWebhook, eventemitter);
module.exports = TwitchWebhook;
