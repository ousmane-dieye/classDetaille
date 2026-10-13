import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';

type Pair = { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey };

function issue(cn: string, issuer: Pair | undefined, isCa: boolean, altNames: string[] = []): Pair {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const subject = [{ name: 'commonName', value: cn }];
  cert.setSubject(subject);
  cert.setIssuer(issuer ? issuer.cert.subject.attributes : subject);
  const ext: object[] = [{ name: 'basicConstraints', cA: isCa }];
  if (altNames.length) ext.push({ name: 'subjectAltName', altNames: altNames.map((v) => ({ type: 2, value: v })) });
  cert.setExtensions(ext);
  cert.sign(issuer ? issuer.key : keys.privateKey, forge.md.sha256.create());
  return { cert, key: keys.privateKey };
}

/** PKI de TEST uniquement, régénérée à chaque exécution et jamais versionnée. */
export function makeTestPki(serverHost: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-pki-'));
  const write = (name: string, data: string | Buffer) => { const p = join(dir, name); writeFileSync(p, data); return p; };
  const ca = issue('cp-test-ca', undefined, true);
  const server = issue(serverHost, ca, false, [serverHost, 'localhost']);
  return {
    dir,
    caCrt: write('ca.crt', forge.pki.certificateToPem(ca.cert)),
    serverCrt: write('server.crt', forge.pki.certificateToPem(server.cert)),
    serverKey: write('server.key', forge.pki.privateKeyToPem(server.key)),
    clientFor(cn: string, password = 'p12-test') {
      const c = issue(cn, ca, false);
      const p12 = forge.pkcs12.toPkcs12Asn1(c.key, [c.cert, ca.cert], password, { algorithm: '3des' });
      return {
        crt: write(`${cn}.crt`, forge.pki.certificateToPem(c.cert)),
        key: write(`${cn}.key`, forge.pki.privateKeyToPem(c.key)),
        p12: write(`${cn}.p12`, Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary')),
        password,
      };
    },
    foreignCa() { return write('foreign-ca.crt', forge.pki.certificateToPem(issue('other-ca', undefined, true).cert)); },
  };
}
