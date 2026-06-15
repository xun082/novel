import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 关掉开发期的双挂载：/outlines 的 useEffect 里同时做了「消费 URL ?go=」「清缓存」
  // 「开 generation」三件副作用，Strict Mode 的 mount→unmount→mount 会让第一次消费完
  // 之后第二次发现没东西可做，把用户闪回首页。生产环境不会双挂载，这里只是把 dev 表现
  // 对齐到生产。
  reactStrictMode: false,
};

export default nextConfig;
