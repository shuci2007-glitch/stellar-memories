/**
 * 桌面端云端接入。
 *
 * 云服务端会做**精确 Origin 匹配**（publishableKey 与 Origin 绑定），而 Tauri webview 的
 * Origin 不是官方域名，直接用 window.fetch 会得到 invalid_client。
 * 更麻烦的是 `Origin` 属于 Fetch 规范的 forbidden header —— 浏览器/WebView 在
 * `new Headers()` 时就会把它丢弃，前端根本设不住。
 * 因此这里通过 Rust 命令 `cloud_request` 发请求，由 reqwest 显式带上官方 Origin。
 */

import { invoke } from "@tauri-apps/api/core";

export const CLOUD_ORIGIN = "https://stellar-memories.app.workbuddy.host";

const PUBLIC_CONFIG = {
  endpoint: CLOUD_ORIGIN,
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  // 与网页端同一把 publishableKey（本身无权限，服务端靠 Origin + 登录态鉴权）
  publishableKey: "wbpk_NeDU8sI7qtwpYnWeUJ2wSy_HiUpMliIeCrmgHrtVWeoPp24lsZcjis6",
};

type CloudRawResponse = { status: number; headers: [string, string][]; body: string };

// 这些响应头交给浏览器管理，手动设置会抛错
const SKIP_RESPONSE_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
]);

function headersToObject(src: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!src) return out;
  const anySrc = src as any;
  if (typeof anySrc.forEach === "function" && !Array.isArray(anySrc)) {
    anySrc.forEach((v: string, k: string) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(src)) {
    for (const pair of src as [string, string][]) out[pair[0]] = pair[1];
    return out;
  }
  return { ...(src as Record<string, string>) };
}

/** 二进制转 base64（分块处理，避免大文件爆栈） */
async function toBase64(buf: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode(...(Array.from(slice) as number[]));
  }
  return btoa(binary);
}

/** 供 SDK 使用的 fetch：经 Rust 侧发出，附带官方 Origin；支持文本与二进制 body */
async function cloudFetch(input: any, init?: any): Promise<Response> {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input?.url;
  const headers = headersToObject(init?.headers);
  headers["Origin"] = CLOUD_ORIGIN;

  let bodyText: string | undefined;
  let bodyBase64: string | undefined;
  const raw = init?.body;

  if (typeof raw === "string") {
    bodyText = raw;
  } else if (typeof FormData !== "undefined" && raw instanceof FormData) {
    // 借 Response 让浏览器自动生成 multipart 边界，再把编码后的字节转 base64
    const encoded = new Response(raw);
    const ct = encoded.headers.get("content-type");
    if (ct) headers["Content-Type"] = ct;
    bodyBase64 = await toBase64(await encoded.arrayBuffer());
  } else if (typeof Blob !== "undefined" && raw instanceof Blob) {
    if (raw.type) headers["Content-Type"] = raw.type;
    bodyBase64 = await toBase64(await raw.arrayBuffer());
  } else if (typeof ArrayBuffer !== "undefined" && raw instanceof ArrayBuffer) {
    bodyBase64 = await toBase64(raw);
  }

  const resp = await invoke<CloudRawResponse>("cloud_request", {
    method: String(init?.method || "GET").toUpperCase(),
    url,
    headers: Object.entries(headers),
    body: bodyText,
    bodyBase64,
  });

  const respHeaders = new Headers();
  for (const [k, v] of resp.headers || []) {
    if (!SKIP_RESPONSE_HEADERS.has(String(k).toLowerCase())) respHeaders.set(k, v);
  }
  const noBody = resp.status === 204 || resp.status === 304;
  return new Response(noBody ? null : resp.body, {
    status: resp.status,
    headers: respHeaders,
  });
}

let client: any = null;

/** 取（并缓存）云端 client。SDK 通过 index.html 的 CDN script 挂到 window.WorkBuddyCloud */
export function getCloud(): any {
  if (client) return client;
  const WB = (window as any).WorkBuddyCloud;
  if (!WB || typeof WB.createWorkBuddyCloud !== "function") {
    throw new Error("云端 SDK 未加载，请检查网络或稍后重试");
  }
  client = WB.createWorkBuddyCloud({
    endpoint: PUBLIC_CONFIG.endpoint,
    oauthRelayBaseUrl: PUBLIC_CONFIG.oauthRelayBaseUrl,
    publishableKey: PUBLIC_CONFIG.publishableKey,
    fetch: cloudFetch,
  });
  return client;
}

export type CloudAlbum = {
  id: number;
  name: string;
  kind: string;
  family_id: number | null;
  created_at?: string;
};

export type CloudMedia = {
  id: number;
  storage_path: string;
  media_type: string;
  meta?: { name?: string; size?: number } | null;
  created_at?: string;
};

export async function fetchCloudAlbums(): Promise<CloudAlbum[]> {
  const cloud = getCloud();
  const { data, error } = await cloud.database
    .from("albums")
    .select("id, name, kind, family_id, created_at")
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message || "读取云端相册失败");
  return (data || []) as CloudAlbum[];
}

export async function fetchCloudMedia(albumId: number): Promise<CloudMedia[]> {
  const cloud = getCloud();
  const { data, error } = await cloud.database
    .from("media")
    .select("id, storage_path, media_type, meta, created_at")
    .eq("album_id", albumId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message || "读取相册内容失败");
  return (data || []) as CloudMedia[];
}

export async function signedUrlFor(path: string): Promise<string> {
  const cloud = getCloud();
  // 1 小时有效期，避免看图过程中链接过期
  const { data, error } = await cloud.storage.createSignedUrl(path, 3600);
  if (error) throw new Error(error.message || "获取图片地址失败");
  return (data && (data.url || data.signedUrl)) || "";
}

/** 当前登录用户标识（手机号优先，取不到回退昵称） */
export function sessionLabel(session: any): string {
  const u = session?.user || {};
  const raw = u.phone || u.phone_number || u.name || u.email || "";
  const s = String(raw || "");
  if (/^1\d{10}$/.test(s)) return s.replace(/(\d{3})\d{4}(\d{4})/, "$1****$2");
  return s || "已登录";
}
