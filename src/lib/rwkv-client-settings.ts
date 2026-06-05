const LS_URL = "novel:rwkv:upstreamUrl";
const LS_PASSWORD = "novel:rwkv:upstreamPassword";

export interface RwkvClientCredentials {
  upstreamUrl: string;
  password: string;
}

export function readRwkvClientCredentials(): RwkvClientCredentials {
  if (typeof window === "undefined") return { upstreamUrl: "", password: "" };
  return {
    upstreamUrl: localStorage.getItem(LS_URL) ?? "",
    password: localStorage.getItem(LS_PASSWORD) ?? "",
  };
}

export function writeRwkvClientCredentials(creds: RwkvClientCredentials): void {
  if (typeof window === "undefined") return;
  const { upstreamUrl, password } = creds;
  if (upstreamUrl) localStorage.setItem(LS_URL, upstreamUrl);
  else localStorage.removeItem(LS_URL);
  if (password) localStorage.setItem(LS_PASSWORD, password);
  else localStorage.removeItem(LS_PASSWORD);
}

export function clearRwkvClientCredentials(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(LS_URL);
  localStorage.removeItem(LS_PASSWORD);
}

/** 可选：合并进 POST JSON，字段名与 UpstreamStreamRequest 一致，由服务端 zod 校验 */
export function rwkvCredentialsForApiBody(): {
  upstreamUrl?: string;
  password?: string;
} {
  const { upstreamUrl, password } = readRwkvClientCredentials();
  const o: { upstreamUrl?: string; password?: string } = {};
  if (upstreamUrl) o.upstreamUrl = upstreamUrl;
  if (password) o.password = password;
  return o;
}
