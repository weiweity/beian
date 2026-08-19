import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tls from "node:tls";

const here = dirname(fileURLToPath(import.meta.url));
const G2_PATH = join(here, "digicert-global-root-g2.pem");

function splitPem(blob: string): string[] {
  const out: string[] = [];
  const re = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blob))) out.push(`${m[0]}\n`);
  return out;
}

function extraCas(): string[] {
  const cas: string[] = [];
  if (existsSync(G2_PATH)) cas.push(...splitPem(readFileSync(G2_PATH, "utf8")));
  const files = [
    process.env.SSL_CERT_FILE,
    process.env.NODE_EXTRA_CA_CERTS,
    "/etc/ssl/cert.pem",
    "/etc/ssl/certs/ca-certificates.crt",
  ].filter((p): p is string => Boolean(p && existsSync(p)));
  for (const file of files) cas.push(...splitPem(readFileSync(file, "utf8")));
  return cas;
}

/** Homebrew Node 25 的 OpenSSL 包没有 DigiCert，飞书换票会报 SELF_SIGNED_CERT_IN_CHAIN。 */
export function trustPublicCas(): number {
  if (typeof tls.setDefaultCACertificates !== "function") return 0;
  const bundled = tls.rootCertificates || [];
  const system = typeof tls.getCACertificates === "function" ? tls.getCACertificates("system") : [];
  const extra = extraCas();
  tls.setDefaultCACertificates([...bundled, ...system, ...extra]);
  return extra.length;
}

trustPublicCas();
