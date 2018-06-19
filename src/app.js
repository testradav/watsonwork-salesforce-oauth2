// A sample app that listens to messages posted to a space in IBM
// Watson Workspace and implements actions that return the user's messages.

import express from 'express';
import * as bparser from 'body-parser';
import * as http from 'http';
import * as https from 'https';
import * as oauth from './oauth';
import * as ssl from './ssl';
import * as sign from './sign';
import * as messages from './messages';
import * as events from './events';
import * as state from './state';
import googleClient from './google';
// import { google } from 'googleapis';
import debug from 'debug';

// Debug log
const log = debug('watsonwork-messages-app');

// Handle events sent to the Weather action Webhook at /messages
export const messagesCallback = (appId, store, wwToken) =>
  (req, res) => {
    log('Received body %o', req.body);

    // Get the space containing the conversation that generated the event
    const spaceId = req.body.spaceId;

    // Respond to the Webhook right away, as any response messages will
    // be sent asynchronously
    res.status(201).end();
    
    // handles action fulfillment annotations
    events.onActionSelected(req.body, appId,
      (actionId, action, userId) => {
        const args = actionId.split(' ');
      	switch(args[0]) {
          case '/messages':
            handleCommand(action, userId, spaceId, wwToken);
            break;
        }
      });
  };

export const oauthCompleteCallback = (store, wwToken) => (req, res) => {
  log('completed oauth flow, resuming user action...');
  res.status(201).end();

  const userId = querystring.parse(url.parse(req.url).query).state;
  state.run(userId, store, (err, ostate, put) => {
    log('completing user action with state %o error %o', ostate, err);
    if (err) {
      return;
    }
    const { actionType, action, spaceId, tokens } = ostate;
    switch(actionType) {
      case '/messages':
        handleCommand(action, userId, spaceId, wwToken);
        // once complete, remove state for user except for tokens
        put(null, { tokens });
        break;
    }
  })
}

const handleCommand = (action, userId, spaceId, wwToken) => {
  messages.sendTargeted(
    action.conversationId,
    userId,
    action.targetDialogId,
    'Your Messages',
    `This is where your messages would show up`,
    wwToken()
  );
}

const beginReauth = (wwToken) => (spaceId, userId) => {
  const scopes = ['https://www.googleapis.com/auth/gmail.readonly'];
  googleClient.makeAuthorizeUrl(userId, scopes);
  messages.send(spaceId, null, `[Log in to Gmail](${googleClient.authorizeUrl})`, null, wwToken());
}

// Create Express Web app
export const webapp =
  (appId, secret, whsecret, initialStore, cb) => {
    // Authenticate the app and get an OAuth token
    oauth.run(appId, secret, (err, wwToken) => {
      if(err) {
        cb(err);
        return;
      }

      const store = state.store(initialStore);
      
      const app = express();
      // Configure Express route for the app Webhook
      app.post('/messages',

        // Verify Watson Work request signature and parse request body
        bparser.json({
          type: '*/*',
          verify: sign.verify(whsecret)
        }),

        // Handle Watson Work Webhook challenge requests
        sign.challenge(whsecret),

        googleClient.checkToken(appId, store, beginReauth(wwToken)),

        // Handle Watson Work Webhook events
        messagesCallback(appId, store, wwToken)
      );

      // google will call this endpoint after a user completes their authentication,
      // then this app will complete the OAuth2 handshake by getting an access token from google
      app.get('/oauth2callback',
        googleClient.handleCallback(store),
        oauthCompleteCallback(store, wwToken)
      );

      // Return the Express Web app
      cb(null, app);

        
    });
  };

// App main entry point
const main = (argv, env, cb) => {
  // Create Express Web app
  webapp(
    env.WW_APP_ID,
    env.WW_APP_SECRET,
    env.WW_WEBHOOK_SECRET,
    env.WW_STORE,
    (err, app) => {
      if(err) {
        cb(err);
        return;
      }

      if(env.PORT) {
        // In a hosting environment like Bluemix for example, HTTPS is
        // handled by a reverse proxy in front of the app, just listen
        // on the configured HTTP port
        log('HTTP server listening on port %d', env.PORT);
        http.createServer(app).listen(env.PORT, cb);
      }

      else
        // Listen on the configured HTTPS port, default to 443
        ssl.conf(env, (err, conf) => {
          if(err) {
            cb(err);
            return;
          }
          const port = env.SSLPORT || 443;
          log('HTTPS server listening on port %d', port);
          https.createServer(conf, app).listen(port, cb);
        });
    });
};

if (require.main === module) {
  main(process.argv, process.env, (err) => {
    if(err) {
      console.log('Error starting app:', err);
      return;
    }
    log('App started');
  });
}
