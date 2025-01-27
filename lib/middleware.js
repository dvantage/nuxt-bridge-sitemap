const { gzipSync } = require('zlib')

const generateETag = require('etag')
const fresh = require('fresh')

const { eventHandler } = require('h3')

const { createSitemap, createSitemapIndex, fetchFromRedis } = require('./builder')
const { createRoutesCache } = require('./cache')
const logger = require('./logger')
const { setDefaultSitemapOptions, setDefaultSitemapIndexOptions } = require('./options')
const { excludeRoutes } = require('./routes')

/**
 * Register a middleware for each sitemap or sitemapindex
 *
 * @param {Object} options
 * @param {Object} globalCache
 * @param {Nuxt}   nuxtInstance
 * @param {number} depth
 */
async function registerSitemaps(options, globalCache, nuxtInstance, depth = 0) {
  /* istanbul ignore if */
  if (depth > 1) {
    // see https://webmasters.stackexchange.com/questions/18243/can-a-sitemap-index-contain-other-sitemap-indexes
    logger.warn("A sitemap index file can't list other sitemap index files, but only sitemap files")
  }

  const isSitemapIndex = options && options.sitemaps && Array.isArray(options.sitemaps) && options.sitemaps.length > 0

  if (isSitemapIndex) {
    await registerSitemapIndex(options, globalCache, nuxtInstance, depth)
  } else {
    await registerSitemap(options, globalCache, nuxtInstance, depth)
  }
}

/**
 * Register a middleware to serve a sitemap
 *
 * @param {Object} options
 * @param {Object} globalCache
 * @param {Nuxt}   nuxtInstance
 * @param {number} depth
 */
function registerSitemap(options, globalCache, nuxtInstance, depth = 0) {
  const base = nuxtInstance.options.router.base

  // Init options
  options = setDefaultSitemapOptions(options, nuxtInstance, depth > 0)

  // Init cache
  const cache = {}
  cache.staticRoutes = () => excludeRoutes(options.exclude, globalCache.staticRoutes)
  cache.routes = createRoutesCache(cache, options)

  // On run cmd "start" or "generate [--no-build]"
  if (globalCache.staticRoutes) {
    // On server ready
    nuxtInstance.nuxt.hook('listen', () => {
      // Hydrate cache
      cache.routes.get('routes')
    })
  }

  if (options.gzip) {
    // Add server middleware for sitemap.xml.gz
    nuxtInstance.addServerMiddleware({
      path: options.pathGzip,
      handler: eventHandler(async (event) => {
        const { req, res } = event.node
        try {
          // Init sitemap
          const routes = await cache.routes.get('routes')
          const gzip = await createSitemap(options, routes, base, req).toGzip()
          // Check cache headers
          if (validHttpCache(gzip, options.etag, req, res)) {
            return
          }
          // Send http response
          res.setHeader('Content-Type', 'application/gzip')
          res.end(gzip)
        } catch (err) {
          return err
        }
      }),
    })
  }

  // Add server middleware for sitemap.xml
  nuxtInstance.addServerMiddleware({
    path: options.path,
    /**
     * @param {Request} req
     * @param {Response} res
     * @param {*} next
     */
    handler: eventHandler(async (event) => {
      const { req, res } = event.node
      try {
        // Init sitemap
        const routes = await cache.routes.get('routes')
        const sitemap = await createSitemap(options, routes, base, req)
        const xml = sitemap.toXML()
        // Check cache headers
        if (validHttpCache(xml, options.etag, req, res)) {
          return
        }
        // Send http response
        res.setHeader('Content-Type', 'application/xml')
        res.end(xml)
      } catch (err) {
        return err
      }
    }),
  })
}

/**
 * Register middleware to serve a sitemapindex
 *
 * @param {Object} options
 * @param {Object} globalCache
 * @param {Nuxt}   nuxtInstance
 * @param {number} depth
 */
async function registerSitemapIndex(options, globalCache, nuxtInstance, depth = 0) {
  const base = nuxtInstance.options.router.base

  if (options.redis !== undefined && options.redis.useForSitemap) {
    const sitemaps = await fetchFromRedis(options, true, true)
    if (sitemaps.length > 0) {
      options.sitemaps = options.sitemaps.concat(sitemaps)
    }
  }

  // Init options
  options = setDefaultSitemapIndexOptions(options, nuxtInstance)

  if (options.gzip) {
    // Add server middleware for sitemapindex.xml.gz
    nuxtInstance.addServerMiddleware({
      path: options.pathGzip,
      handler: eventHandler(async (event) => {
        const { req, res } = event.node
        // Init sitemap index
        const sitemapIndex = await createSitemapIndex(options, base, req)
        const gzip = gzipSync(sitemapIndex)
        // Check cache headers
        if (validHttpCache(gzip, options.etag, req, res)) {
          return
        }
        // Send http response
        res.setHeader('Content-Type', 'application/gzip')
        res.end(gzip)
      }),
    })
  }

  // Add server middleware for sitemapindex.xml
  nuxtInstance.addServerMiddleware({
    path: options.path,
    handler: eventHandler(async (event) => {
      const { req, res } = event.node
      // Init sitemap index
      const xml = await createSitemapIndex(options, base, req)
      // Check cache headers
      if (validHttpCache(xml, options.etag, req, res)) {
        return
      }
      // Send http response
      res.setHeader('Content-Type', 'application/xml')
      res.end(xml)
    }),
  })

  // Register linked sitemaps
  for (const sitemapOptions of options.sitemaps) {
    await registerSitemaps(sitemapOptions, globalCache, nuxtInstance, depth + 1)
  }
}

/**
 * Validate the freshness of HTTP cache using headers
 *
 * @param {Object} entity
 * @param {Object} options
 * @param {Request} req
 * @param {Response} res
 * @returns {boolean}
 */
function validHttpCache(entity, options, req, res) {
  if (!options) {
    return false
  }
  const { hash } = options
  const etag = hash ? hash(entity, options) : generateETag(entity, options)
  if (fresh(req.headers, { etag })) {
    // Resource isn't modified
    res.statusCode = 304
    res.end()
    return true
  }
  // Add ETag header
  res.setHeader('ETag', etag)
  return false
}

module.exports = { registerSitemaps, registerSitemap, registerSitemapIndex }
