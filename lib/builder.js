const { hostname } = require('os')
const { join } = require('path')
const { URL } = require('url')

const isHTTPS = require('is-https')
const sm = require('sitemap')

const Redis = require('ioredis')
const logger = require('./logger')

/**
 * Initialize a fresh sitemap instance
 *
 * @param   {Object}  options
 * @param   {Array}   routes
 * @param   {string}  base
 * @param   {Request} req
 * @returns {Sitemap} sitemap instance
 */
async function createSitemap(options, routes, base = null, req = null) {
  //
  if (options.dynamic && options.redis !== undefined && options.redis.useForSitemap) {
    const sitemaps = await fetchFromRedis(options)
    if (sitemaps.length > 0) {
      const sitemap = sitemaps.find((sitemap) => sitemap.path === options.path)
      if (sitemap !== undefined) {
        routes = sitemap.routes
      }
    }
  }

  const sitemapConfig = {}

  // Set cacheTime
  sitemapConfig.cacheTime = options.cacheTime || 0

  // Set sitemap hostname
  sitemapConfig.hostname = getHostname(options, req, base)

  // Set XML namespaces
  sitemapConfig.xmlNs = options.xmlNs

  // Set XSL url
  sitemapConfig.xslUrl = options.xslUrl

  // Set default values to each route
  routes = routes.map((route) => ({ ...options.defaults, ...route }))

  // Add a trailing slash to each route URL
  if (options.trailingSlash) {
    routes = routes.map((route) => {
      if (!route.url.endsWith('/')) {
        route.url = `${route.url}/`
      }
      return route
    })
  }

  // Add alternate i18n routes
  if (options.i18n) {
    const { locales, routesNameSeparator } = options.i18n

    // Set alternate routes for each page
    routes.reduce((i18nRoutes, route) => {
      if (!route.name) {
        return i18nRoutes
      }

      const [page, lang, isDefault = false] = route.name.split(routesNameSeparator)

      if (!lang) {
        return i18nRoutes
      }

      // Init alternate route
      const link = {
        lang,
        url: join('.', route.url),
      }
      if (isDefault) {
        link.lang = 'x-default'
      } else {
        const locale = locales.find(({ code }) => code === lang)
        if (locale && locale.iso) {
          link.lang = locale.iso
        }
      }

      // Group alternate routes by page and sorted by lang
      if (!i18nRoutes[page]) {
        i18nRoutes[page] = []
      }
      const langs = i18nRoutes[page].map(({ lang }) => lang)
      langs.push(link.lang)
      const index = langs.sort().indexOf(link.lang)
      i18nRoutes[page].splice(index, 0, link)

      // Set alternate routes
      route.links = i18nRoutes[page]

      return i18nRoutes
    }, {})
  }

  // Enable the custom filter function for each declared route
  if (typeof options.filter === 'function') {
    routes = options.filter({
      options: { ...sitemapConfig },
      routes,
    })
  }

  routes = routes.map((route) => {
    // Omit the router data
    const { chunkName, component, name, path, ...sitemapOptions } = route

    // Normalize to an absolute path
    return {
      ...sitemapOptions,
      url: join('.', String(sitemapOptions.url)),
    }
  })

  // Set urls
  sitemapConfig.urls = routes

  // Create sitemap instance
  return sm.createSitemap(sitemapConfig)
}

/**
 * Initialize a fresh sitemapindex instance
 *
 * @param   {Object}  options
 * @param   {string}  base
 * @param   {Request} req
 * @returns {string}
 */
async function createSitemapIndex(options, base = null, req = null) {
  let sitemaps = options.sitemaps

  if (options.redis !== undefined && options.redis.useForSitemap) {
    sitemaps = sitemaps.filter((sitemap) => !sitemap.dynamic)
    const sitemapsFromRedis = await fetchFromRedis(options, true)
    if (sitemapsFromRedis.length > 0) {
      sitemaps = sitemaps.concat(sitemapsFromRedis)
    }
  }

  const sitemapIndexConfig = {}

  // Set urls
  const defaultHostname = options.hostname
  sitemapIndexConfig.urls = sitemaps.map((options) => {
    // Normalize to absolute path
    const path = join('.', options.gzip ? `${options.path}.gz` : options.path)
    const hostname = getHostname(options.hostname ? options : { ...options, hostname: defaultHostname }, req, base)
    const url = new URL(path, hostname)
    return { url: url.href, lastmod: options.lastmod }
  })

  // Set lastmod for each sitemap
  sitemapIndexConfig.lastmod = options.lastmod

  // Set XML namespaces
  sitemapIndexConfig.xmlNs = options.xmlNs

  // Set XSL url
  sitemapIndexConfig.xslUrl = options.xslUrl

  // Create a sitemapindex
  return sm.buildSitemapIndex(sitemapIndexConfig)
}

/**
 * Determine the current hostname
 *
 * @param   {Object}  options
 * @param   {Request} req
 * @param   {string}  base
 * @returns {string}
 */
function getHostname(options, req, base) {
  /* istanbul ignore if */
  if (!options.hostname && !req) {
    logger.fatal('The `hostname` option is mandatory in your config on `spa` or `generate` build mode', options)
  }
  return new URL(
    base,
    options.hostname || (req && `${isHTTPS(req) ? 'https' : 'http'}://${req.headers.host}`) || `http://${hostname()}`
  ).href
}

/**
 *
 * @param options
 * @param skipRoutes
 * @param preRegistrationForFutureRoutes
 * @returns {Promise<*[]>}
 */
async function fetchFromRedis(options, skipRoutes = false, preRegistrationForFutureRoutes = false) {
  if (options.redis === undefined || options.redis === null || Object.keys(options.redis).length === 0) {
    return []
  }

  const defaultOptions = {
    host: '127.0.0.1',
    port: 6379,
  }

  let redisKey = 'sitemap-url'
  let partNamespace = 'sitemap'
  let useGzip = false

  if (options.redis.useGzip !== undefined) {
    useGzip = options.redis.useGzip
  }

  if (options.redis.keyName !== undefined) {
    redisKey = options.redis.keyName
  }

  if (options.redis.partNamespace !== undefined) {
    partNamespace = options.redis.partNamespace
  }

  const redis = new Redis({ ...defaultOptions, ...options.redis.config })
  const totalUrls = await redis.llen(redisKey)
  const pageSize = 5000
  const sitemapCount = Math.ceil(totalUrls / pageSize)

  let lastmod = new Date().toISOString()

  const sitemaps = []
  let lastPart = null
  for (let i = 0; i < sitemapCount; i++) {
    const start = i * pageSize
    const end = start + pageSize - 1

    let routes = await redis.lrange(redisKey, start, end)

    routes = routes.map((item) => {
      return {
        ...JSON.parse(item),
      }
    })

    if (routes.length > 0) {
      if (routes.length === 1) {
        const [route] = sitemaps
        lastmod = route.lastmod
      } else {
        lastmod = routes[routes.length - 1].lastmod
      }
    }

    if (skipRoutes) {
      routes = []
    }

    const partPath = `/${partNamespace}-part${i + 1}.xml`

    lastPart = i + 1

    sitemaps.push({
      path: partPath,
      routes, // Routes will be requested from Redis on every request
      gzip: useGzip,
      exclude: ['/**'],
      dynamic: true,
      lastmod,
      redis: options.redis,
    })
  }

  // Let's register two more routes in advance (for 2 XML files)
  if (preRegistrationForFutureRoutes && lastPart !== null) {
    for (let i = 1; i <= 2; i++) {
      sitemaps.push({
        path: `/${partNamespace}-part${lastPart + i}.xml`,
        routes: [], // Routes will be requested from Redis on every request
        gzip: useGzip,
        exclude: ['/**'],
        dynamic: true,
        lastmod: new Date().toISOString(),
        redis: options.redis,
      })
    }
  }

  return sitemaps
}

module.exports = { createSitemap, createSitemapIndex, fetchFromRedis }
