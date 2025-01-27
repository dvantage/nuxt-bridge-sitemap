import { defineNuxtConfig } from '@nuxt/bridge'

export default defineNuxtConfig({
  bridge: true,
  srcDir: __dirname,
  render: {
    resourceHints: false,
  },
  modules: ['../lib/module'],
  sitemap: {
    redis: {
      useForSitemap: true,
      useGzip: true,
      keyName: 'some-redis-key',
      partNamespace: 'item',
      config: {
        host: '127.0.0.1',
        port: 6379,
        password: '123',
      },
    },
    // gzip: true,
    path: '/sitemap.xml',
    sitemaps: [
      {
        path: '/static-pages.xml',
        lastmod: new Date().toISOString(),
        // gzip: true,
        exclude: ['/foo3'],
      },
      {
        path: '/sitemap-foo.xml',
        routes: ['foo/1', 'foo/2'],
      },
    ],
    hostname: 'http://localhost:3000/',
  },
})
