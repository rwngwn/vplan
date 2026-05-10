/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    const apiBase = process.env.API_INTERNAL_URL || 'http://localhost:8000'
    return [
      {
        source: '/api/:path*',
        destination: `${apiBase}/:path*`,
      },
    ]
  },
}

module.exports = nextConfig
