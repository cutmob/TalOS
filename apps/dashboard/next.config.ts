import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Enable standalone output for Docker deployments
  output: 'standalone',
  // Proxy all /api/* requests to the Fastify API server
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.API_SERVER_URL ?? 'http://localhost:3001'}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
