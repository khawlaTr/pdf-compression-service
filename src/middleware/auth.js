'use strict';

// Validates the XSUAA-issued bearer token CPI presents (OAuth2ClientCredentials
// grant against this app's own XSUAA service instance). Bypassed entirely
// when AUTH_DISABLED=true, for local development and the CLI test script
// only — never set that in a deployed environment.
//
// No custom scope check: a client_credentials token against XSUAA only ever
// carries the built-in `uaa.resource` scope (confirmed empirically against
// the real deployed instance — decoding the token showed `scope: ["uaa.resource"]`
// despite `Compress` being defined in xs-security.json). Custom scopes are a
// user/role-collection concept and don't apply to this machine-to-machine
// flow. The actual authorization guarantee is that only a holder of this
// exact XSUAA instance's client secret can obtain a token that verifies
// against its public key — successful createSecurityContext() already proves
// that, so no further check is needed.
//
// API verified against @sap/xssec 4.15.0's own README (createSecurityContext
// / XsuaaService / SECURITY_CONTEXT) after an earlier version of this file,
// written against the older passport-strategy-based API, failed in
// production with "xssec.JWTStrategy is not a constructor".

const { createSecurityContext, XsuaaService, SECURITY_CONTEXT, errors } = require('@sap/xssec');
const xsenv = require('@sap/xsenv');
const config = require('../config');

let authService;

function getAuthService() {
  if (!authService) {
    const services = xsenv.getServices({ uaa: { tag: 'xsuaa' } });
    authService = new XsuaaService(services.uaa);
  }
  return authService;
}

async function authMiddleware(req, res, next) {
  if (config.authDisabled) return next();

  try {
    const secContext = await createSecurityContext(getAuthService(), { req });
    req[SECURITY_CONTEXT] = secContext;
    req.authInfo = secContext;
    next();
  } catch (e) {
    if (e instanceof errors.ValidationError) {
      const authHeader = req.headers.authorization;
      // eslint-disable-next-line no-console
      console.warn(
        '[pdf-compression-service] 401:',
        authHeader ? `Authorization header present (${authHeader.slice(0, 15)}...)` : 'no Authorization header at all',
        '-',
        e.message,
      );
      return res.status(401).json({ error: 'unauthorized', message: 'Jeton XSUAA absent ou invalide.' });
    }
    // eslint-disable-next-line no-console
    console.error('[pdf-compression-service] auth error:', e);
    res.status(500).json({ error: 'internal_error', message: "Erreur interne d'authentification." });
  }
}

module.exports = authMiddleware;
