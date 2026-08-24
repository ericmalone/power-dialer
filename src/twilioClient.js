'use strict';

const twilio = require('twilio');
const config = require('./config');

let client = null;

function getClient() {
  if (!config.twilio.accountSid || !config.twilio.authToken) {
    throw new Error(
      'Twilio is not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in your .env file.'
    );
  }
  if (!client) {
    client = twilio(config.twilio.accountSid, config.twilio.authToken);
  }
  return client;
}

/** Allows tests to inject a fake. */
function setClient(fake) {
  client = fake;
}

/**
 * Mint a Voice access token for a browser softphone identity.
 */
function makeAccessToken(identity, ttlSeconds = 3600) {
  const { AccessToken } = twilio.jwt;
  const { VoiceGrant } = AccessToken;

  if (!config.twilio.apiKeySid || !config.twilio.apiKeySecret) {
    throw new Error('Missing TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET.');
  }
  if (!config.twilio.twimlAppSid) {
    throw new Error('Missing TWILIO_TWIML_APP_SID.');
  }

  const token = new AccessToken(
    config.twilio.accountSid,
    config.twilio.apiKeySid,
    config.twilio.apiKeySecret,
    { identity, ttl: ttlSeconds }
  );

  token.addGrant(
    new VoiceGrant({
      outgoingApplicationSid: config.twilio.twimlAppSid,
      incomingAllow: true,
    })
  );

  return token.toJwt();
}

/** Stable, URL-safe softphone identity for a user row. */
function identityFor(user) {
  return `agent_${user.id}`;
}

function userIdFromIdentity(identity) {
  const m = /^agent_(\d+)$/.exec(String(identity || ''));
  return m ? Number(m[1]) : null;
}

/** Each agent gets their own conference room; leads are bridged into it. */
function conferenceNameFor(userId) {
  return `agent-room-${userId}`;
}

module.exports = {
  twilio,
  getClient,
  setClient,
  makeAccessToken,
  identityFor,
  userIdFromIdentity,
  conferenceNameFor,
};
