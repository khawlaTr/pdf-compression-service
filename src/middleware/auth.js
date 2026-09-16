'use strict';

// Validates the XSUAA-issued bearer token CPI presents (OAuth2ClientCredentials
// grant against this app's XSUAA service instance) and requires the
// `Compress` scope. Bypassed entirely when AUTH_DISABLED=true, for local
// development and the CLI test script only — never set that in a deployed
// environment.
//
// NOTE: verify the exact @sap/xssec API against the version actually
// installed (`npm ls @sap/xssec`) before relying on this in production —
// the SecurityContext method names have shifted across major versions and
// this couldn't be exercised against a live XSUAA instance in this sandbox.

const config = require('../config');

let xssec;
let xsenv;
let passport;

function lazyLoad() {
  if (xssec) return;
  xssec = require('@sap/xssec');
  xsenv = require('@sap/xsenv');
  passport = require('passport');

  const services = xsenv.getServices({ uaa: { tag: 'xsuaa' } });
  passport.use('JWT', new xssec.JWTStrategy(services.uaa));
  passport.initialize();
}

function authMiddleware(req, res, next) {
  if (config.authDisabled) return next();

  lazyLoad();

  passport.authenticate('JWT', { session: false }, (err, authInfo) => {
    if (err || !authInfo) {
      return res.status(401).json({ error: 'unauthorized', message: 'Jeton XSUAA absent ou invalide.' });
    }
    const hasScope =
      typeof authInfo.checkLocalScope === 'function'
        ? authInfo.checkLocalScope(config.requiredScope)
        : authInfo.hasLocalScope(config.requiredScope);
    if (!hasScope) {
      return res.status(403).json({ error: 'forbidden', message: `Scope "${config.requiredScope}" requis.` });
    }
    req.authInfo = authInfo;
    next();
  })(req, res, next);
}

module.exports = authMiddleware;
