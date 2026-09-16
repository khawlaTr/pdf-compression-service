'use strict';

// Validates the XSUAA-issued bearer token CPI presents (OAuth2ClientCredentials
// grant against this app's XSUAA service instance) and requires the
// `Compress` scope. Bypassed entirely when AUTH_DISABLED=true, for local
// development and the CLI test script only — never set that in a deployed
// environment.
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
    if (!secContext.checkLocalScope(config.requiredScope)) {
      return res.status(403).json({ error: 'forbidden', message: `Scope "${config.requiredScope}" requis.` });
    }
    req[SECURITY_CONTEXT] = secContext;
    req.authInfo = secContext;
    next();
  } catch (e) {
    if (e instanceof errors.ValidationError) {
      return res.status(401).json({ error: 'unauthorized', message: 'Jeton XSUAA absent ou invalide.' });
    }
    // eslint-disable-next-line no-console
    console.error('[pdf-compression-service] auth error:', e);
    res.status(500).json({ error: 'internal_error', message: "Erreur interne d'authentification." });
  }
}

module.exports = authMiddleware;
