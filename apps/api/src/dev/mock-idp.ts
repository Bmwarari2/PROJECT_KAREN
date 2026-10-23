import { createHash, generateKeyPairSync, randomUUID, webcrypto } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { SignJWT, exportJWK, importPKCS8 } from 'jose';
import * as x509 from '@peculiar/x509';
import { SignedXml } from 'xml-crypto';

/**
 * Mock OIDC + SAML identity provider for local development, automated tests and the staging smoke
 * test. It signs in whichever (fictional) user is named by `login_hint`. Never enabled in production
 * (deps.ts refuses to start, and the CDK prod stack asserts MOCK_IDP_ENABLED is absent).
 */
export interface MockIdpKeys {
  privateKeyPem: string;
  certPem: string;
}

x509.cryptoProvider.set(webcrypto as never);

export async function mockIdpKeys(): Promise<MockIdpKeys> {
  if (process.env.MOCK_IDP_KEY_PEM && process.env.MOCK_IDP_CERT_PEM) {
    return { privateKeyPem: process.env.MOCK_IDP_KEY_PEM, certPem: process.env.MOCK_IDP_CERT_PEM };
  }
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const alg = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const keys = {
    privateKey: await webcrypto.subtle.importKey(
      'pkcs8',
      privateKey.export({ type: 'pkcs8', format: 'der' }),
      alg,
      true,
      ['sign'],
    ),
    publicKey: await webcrypto.subtle.importKey(
      'spki',
      (await import('node:crypto')).createPublicKey(privateKey).export({ type: 'spki', format: 'der' }),
      alg,
      true,
      ['verify'],
    ),
  };
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=Thapsus-HR Mock IdP',
    notBefore: new Date(Date.now() - 86_400_000),
    notAfter: new Date(Date.now() + 5 * 365 * 86_400_000),
    signingAlgorithm: alg,
    keys: keys as never,
  });
  return { privateKeyPem, certPem: cert.toString('pem') };
}

const escapeXml = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
  );

export async function mockIdpPlugin(app: FastifyInstance, opts: { baseUrl: string; keys: MockIdpKeys }) {
  // MOCK_IDP_ISSUER_URL: staging without a domain serves a self-signed certificate the API cannot verify
  // when it calls the IdP; there the issuer is the in-task address (http://127.0.0.1:4000/__mock-idp)
  // and only the browser leg goes through the public URL (scripts/smoke-staging.mjs). Never in prod.
  const issuer = process.env.MOCK_IDP_ISSUER_URL ?? `${opts.baseUrl}/__mock-idp`;
  // the token endpoint receives RFC 6749 urlencoded requests (parsed only in this plugin's scope)
  await app.register(formbody);
  const key = await importPKCS8(opts.keys.privateKeyPem, 'RS256');
  const jwk = {
    ...(await exportJWK((await import('node:crypto')).createPublicKey(opts.keys.privateKeyPem))),
    kid: 'mock-1',
    alg: 'RS256',
    use: 'sig',
  };
  const codes = new Map<string, { email: string; nonce?: string; clientId: string; challenge?: string }>();

  app.get(
    '/__mock-idp/.well-known/openid-configuration',
    { config: { auth: 'public' }, schema: { hide: true } },
    async () => ({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    }),
  );
  app.get('/__mock-idp/jwks', { config: { auth: 'public' }, schema: { hide: true } }, async () => ({
    keys: [jwk],
  }));

  app.get(
    '/__mock-idp/authorize',
    { config: { auth: 'public' }, schema: { hide: true } },
    async (req, reply) => {
      const q = req.query as Record<string, string>;
      const code = randomUUID();
      codes.set(code, {
        email: q.login_hint ?? 'sso.user@example.test',
        nonce: q.nonce,
        clientId: q.client_id ?? '',
        challenge: q.code_challenge,
      });
      const url = new URL(q.redirect_uri!);
      url.searchParams.set('code', code);
      url.searchParams.set('state', q.state ?? '');
      url.searchParams.set('iss', issuer);
      return reply.redirect(url.href, 302);
    },
  );

  app.post(
    '/__mock-idp/token',
    { config: { auth: 'public' }, schema: { hide: true } },
    async (req, reply) => {
      const body = req.body as Record<string, string>;
      const entry = codes.get(body.code ?? '');
      codes.delete(body.code ?? '');
      if (!entry) return reply.status(400).send({ error: 'invalid_grant' });
      if (entry.challenge) {
        const computed = createHash('sha256')
          .update(body.code_verifier ?? '')
          .digest('base64url');
        if (computed !== entry.challenge) return reply.status(400).send({ error: 'invalid_grant' });
      }
      const basic = req.headers.authorization?.startsWith('Basic ')
        ? decodeURIComponent(
            Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':')[0]!,
          )
        : body.client_id;
      const idToken = await new SignJWT({
        email: entry.email,
        email_verified: true,
        name: entry.email.split('@')[0],
        nonce: entry.nonce,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'mock-1' })
        .setIssuer(issuer)
        .setAudience(basic ?? entry.clientId)
        .setSubject(createHash('sha256').update(entry.email).digest('hex').slice(0, 24))
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(key);
      return { access_token: randomUUID(), token_type: 'Bearer', expires_in: 300, id_token: idToken };
    },
  );

  // SAML: HTTP-Redirect binding in, HTTP-POST binding out (auto-submitting form).
  app.get(
    '/__mock-idp/saml/sso',
    { config: { auth: 'public' }, schema: { hide: true } },
    async (req, reply) => {
      const q = req.query as Record<string, string>;
      const requestXml = inflateRawSync(Buffer.from(q.SAMLRequest ?? '', 'base64')).toString('utf8');
      const acs = /AssertionConsumerServiceURL="([^"]+)"/.exec(requestXml)?.[1];
      const spIssuer = /<saml:Issuer[^>]*>([^<]+)<\/saml:Issuer>/.exec(requestXml)?.[1];
      const requestId = /ID="([^"]+)"/.exec(requestXml)?.[1];
      if (!acs || !spIssuer) return reply.status(400).send('bad request');
      const email = q.login_hint ?? 'sso.user@example.test';
      const now = new Date();
      const later = new Date(now.getTime() + 5 * 60_000);
      const assertionId = `_${randomUUID()}`;
      const assertion =
        `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${now.toISOString()}">` +
        `<saml:Issuer>${escapeXml(issuer)}</saml:Issuer>` +
        `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${escapeXml(email)}</saml:NameID>` +
        `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${later.toISOString()}" Recipient="${escapeXml(acs)}"${requestId ? ` InResponseTo="${escapeXml(requestId)}"` : ''}/></saml:SubjectConfirmation></saml:Subject>` +
        `<saml:Conditions NotBefore="${new Date(now.getTime() - 60_000).toISOString()}" NotOnOrAfter="${later.toISOString()}"><saml:AudienceRestriction><saml:Audience>${escapeXml(spIssuer)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
        `<saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="${assertionId}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
        `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${escapeXml(email)}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>` +
        `</saml:Assertion>`;
      const sig = new SignedXml({
        privateKey: opts.keys.privateKeyPem,
        publicCert: opts.keys.certPem,
        signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
        canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
      });
      sig.addReference({
        xpath: "//*[local-name(.)='Assertion']",
        transforms: [
          'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
          'http://www.w3.org/2001/10/xml-exc-c14n#',
        ],
        digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      });
      sig.computeSignature(assertion, {
        location: { reference: "//*[local-name(.)='Issuer']", action: 'after' },
      });
      const response =
        `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_${randomUUID()}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${escapeXml(acs)}"${requestId ? ` InResponseTo="${escapeXml(requestId)}"` : ''}>` +
        `<saml:Issuer>${escapeXml(issuer)}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
        sig.getSignedXml() +
        `</samlp:Response>`;
      const b64 = Buffer.from(response).toString('base64');
      const html = `<!doctype html><html><body><form method="post" action="${escapeXml(acs)}"><input type="hidden" name="SAMLResponse" value="${b64}"/><input type="hidden" name="RelayState" value="${escapeXml(q.RelayState ?? '')}"/><noscript><button type="submit">Continue</button></noscript></form><script>document.forms[0].submit()</script></body></html>`;
      return reply
        .type('text/html')
        .header('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; form-action *")
        .send(html);
    },
  );

  return { issuer, samlEntryPoint: `${issuer}/saml/sso`, certPem: opts.keys.certPem };
}
