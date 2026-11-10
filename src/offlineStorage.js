const DB_NAME = 'i-workfolio-offline'
const DB_VERSION = 3
const STORE_NAME = 'offlineData'
const QUEUE_STORE = 'pendingSync'

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('This browser does not support local offline storage.'))
      return
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: 'localId' })
      }

      const queue = request.transaction.objectStore(QUEUE_STORE)
      if (!queue.indexNames.contains('userId')) {
        queue.createIndex('userId', 'userId')
      }
      if (!queue.indexNames.contains('createdAt')) {
        queue.createIndex('createdAt', 'createdAt')
      }
    }

    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }

    request.onerror = () => {
      reject(request.error)
    }
  })
}

export async function saveOfflineData(key, data) {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)

    store.put(data, key)

    transaction.oncomplete = () => {
      resolve(true)
    }

    transaction.onerror = () => {
      reject(transaction.error)
    }
  })
}

export async function getOfflineData(key) {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly')
    const store = transaction.objectStore(STORE_NAME)

    const request = store.get(key)

    request.onsuccess = () => {
      resolve(request.result ?? null)
    }

    request.onerror = () => {
      reject(request.error)
    }
  })
}

export async function deleteOfflineData(key) {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)

    store.delete(key)

    transaction.oncomplete = () => {
      resolve(true)
    }

    transaction.onerror = () => {
      reject(transaction.error)
    }
  })
}

export function isOffline() {
  return !navigator.onLine
}

export function portfolioCacheKey(userId, section) {
  return `portfolio:${userId}:${section}`
}

export async function savePortfolioCache(userId, section, data, updatedAt = new Date().toISOString()) {
  return saveOfflineData(portfolioCacheKey(userId, section), {
    data,
    updatedAt,
  })
}

export async function getPortfolioCache(userId, section) {
  return getOfflineData(portfolioCacheKey(userId, section))
}

export async function getPortfolioEntriesCache(userId) {
  if (!userId) return []
  const db = await openDatabase()
  const prefix = `portfolio:${userId}:`

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly')
    const store = transaction.objectStore(STORE_NAME)
    const keysRequest = store.getAllKeys()

    keysRequest.onsuccess = () => {
      const keys = (keysRequest.result || []).filter((key) => {
        if (typeof key !== 'string' || !key.startsWith(prefix)) return false
        const section = key.slice(prefix.length)
        return section !== '*' && !section.endsWith('/*')
      })
      const entries = []
      for (const key of keys) {
        const request = store.get(key)
        request.onsuccess = () => {
          if (request.result) {
            entries.push({
              section: key.slice(prefix.length),
              content: request.result.data !== undefined
                ? request.result.data
                : request.result,
              updated_at: request.result.updatedAt || null,
            })
          }
        }
        request.onerror = () => reject(request.error)
      }

      transaction.oncomplete = () => resolve(entries)
    }
    keysRequest.onerror = () => reject(keysRequest.error)
    transaction.onerror = () => reject(transaction.error)
  })
}

function photoCacheKey(userId, path) {
  return `portfolio-photo:${userId}:${path}`
}

export async function savePortfolioPhoto(userId, path, file, { pendingUpload = true } = {}) {
  if (!userId || !path || !file) {
    throw new Error('A student account, photo path, and image file are required.')
  }
  if (!file.type?.startsWith('image/')) {
    throw new Error('Only image files can be stored in the portfolio.')
  }

  try {
    await saveOfflineData(photoCacheKey(userId, path), {
      blob: file,
      type: file.type,
      name: file.name || 'portfolio-photo',
      pendingUpload,
    })
  } catch (error) {
    if (error?.name === 'QuotaExceededError') {
      throw new Error(
        'This device is out of storage. Free up browser storage before saving this photo.',
        { cause: error },
      )
    }
    throw error
  }
}

export async function getPortfolioPhoto(userId, path) {
  if (!userId || !path) return null
  return getOfflineData(photoCacheKey(userId, path))
}

export async function getPortfolioPhotos(userId) {
  if (!userId) return []
  const db = await openDatabase()
  const prefix = `portfolio-photo:${userId}:`

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly')
    const store = transaction.objectStore(STORE_NAME)
    const keysRequest = store.getAllKeys()

    keysRequest.onsuccess = () => {
      const keys = (keysRequest.result || []).filter(
        (key) => typeof key === 'string' && key.startsWith(prefix),
      )
      const photos = []
      for (const key of keys) {
        const request = store.get(key)
        request.onsuccess = () => {
          if (request.result?.pendingUpload === false) {
            photos.push({
              path: key.slice(prefix.length),
              name: request.result.name === 'portfolio-photo'
                ? key.slice(prefix.length).split('/').pop()
                : request.result.name || 'Portfolio photo',
            })
          }
        }
        request.onerror = () => reject(request.error)
      }

      transaction.oncomplete = () => resolve(photos)
    }
    keysRequest.onerror = () => reject(keysRequest.error)
    transaction.onerror = () => reject(transaction.error)
  })
}

export async function deletePortfolioPhoto(userId, path) {
  if (!userId || !path) return false
  return deleteOfflineData(photoCacheKey(userId, path))
}

export async function loadPortfolioEntry(client, userId, section) {
  const cached = await getPortfolioCache(userId, section)
  const cachedEntry = cached
    ? {
      content: cached.data !== undefined ? cached.data : cached,
      updated_at: cached.updatedAt || null,
    }
    : null
  const pending = await getPendingSync(userId)
  const pendingEntry = pending.find((item) => (
    item.type === 'portfolio-upsert' && item.row?.section === section
  ))

  if (!navigator.onLine || pendingEntry) {
    return { data: cachedEntry, error: null, fromCache: true }
  }

  let result
  try {
    result = await client
      .from('portfolio_entries')
      .select('content,updated_at')
      .eq('user_id', userId)
      .eq('section', section)
      .maybeSingle()
  } catch (error) {
    if (cachedEntry) return { data: cachedEntry, error: null, fromCache: true }
    return { data: null, error }
  }
  const { data, error } = result

  if (error) {
    if (cachedEntry) return { data: cachedEntry, error: null, fromCache: true }
    return { data: null, error }
  }

  if (data) {
    const updatedAt = data.updated_at || new Date().toISOString()
    await savePortfolioCache(userId, section, data.content, updatedAt)
  }
  return { data, error: null, fromCache: false }
}

async function syncPortfolioEntry(client, item) {
  const { row, userId } = item
  if (!row || !userId || row.user_id !== userId || !row.section) {
    throw new Error('The saved portfolio change does not match the authenticated student.')
  }

  const { data: existing, error: lookupError } = await client
    .from('portfolio_entries')
    .select('updated_at')
    .eq('user_id', userId)
    .eq('section', row.section)
    .maybeSingle()
  if (lookupError) throw lookupError

  const serverTime = existing?.updated_at ? Date.parse(existing.updated_at) : 0
  const localTime = Date.parse(row.updated_at || item.createdAt)
  if (serverTime && Number.isFinite(localTime) && serverTime > localTime) {
    const conflict = new Error('Newer server changes exist for this portfolio section. Your local copy was kept.')
    conflict.code = 'PORTFOLIO_CONFLICT'
    throw conflict
  }

  for (const file of item.files || []) {
    if (
      file.userId !== userId ||
      file.bucket !== 'portfolio-files' ||
      !file.path?.startsWith(`${userId}/`) ||
      !file.file
    ) {
      throw new Error('A queued photo does not belong to the authenticated student.')
    }
    const { error } = await client.storage
      .from(file.bucket || 'portfolio-files')
      .upload(file.path, file.file, {
        upsert: true,
        contentType: file.contentType || file.file.type || 'application/octet-stream',
      })
    if (error) throw error
  }

  const portfolioEntries = client.from('portfolio_entries')
  if (!existing) {
    const { error } = await portfolioEntries.insert(row)
    if (error) throw error
    return
  }

  let update = portfolioEntries
    .update(row)
    .eq('user_id', userId)
    .eq('section', row.section)
  update = existing.updated_at
    ? update.lte('updated_at', row.updated_at || item.createdAt)
    : update.is('updated_at', null)

  const { data: updated, error } = await update
    .select('updated_at')
    .maybeSingle()
  if (error) throw error
  if (!updated) {
    const conflict = new Error('Newer server changes exist for this portfolio section. Your local copy was kept.')
    conflict.code = 'PORTFOLIO_CONFLICT'
    throw conflict
  }
}

export async function savePortfolioEntry(client, row, options = {}, files = []) {
  if (!row?.user_id || !row?.section) {
    throw new Error('A student ID and portfolio section are required to save.')
  }
  if (options?.onConflict && options.onConflict !== 'user_id,section') {
    throw new Error('Portfolio saves must use the existing student-and-section conflict key.')
  }

  const normalizedRow = {
    ...row,
    updated_at: row.updated_at || new Date().toISOString(),
  }
  const localId = `portfolio:${normalizedRow.user_id}:${normalizedRow.section}`

  await savePortfolioCache(
    normalizedRow.user_id,
    normalizedRow.section,
    normalizedRow.content,
    normalizedRow.updated_at,
  )

  const paths = new Set(files.map((file) => file.path).filter(Boolean))
  const collectPaths = (value) => {
    if (typeof value === 'string') {
      if (value.startsWith(`${normalizedRow.user_id}/`)) paths.add(value)
      try {
        const parsed = JSON.parse(value)
        if (parsed !== value) collectPaths(parsed)
      } catch {
        return
      }
    } else if (Array.isArray(value)) {
      value.forEach(collectPaths)
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(collectPaths)
    }
  }
  collectPaths(normalizedRow.content)

  const queuedFiles = []
  for (const path of paths) {
    const stagedPhoto = await getPortfolioPhoto(normalizedRow.user_id, path)
    const suppliedFile = files.find((file) => file.path === path)
    if (suppliedFile?.file) {
      await savePortfolioPhoto(normalizedRow.user_id, path, suppliedFile.file)
    }
    const photo = suppliedFile?.file
      ? { blob: suppliedFile.file, type: suppliedFile.file.type }
      : stagedPhoto
    if (photo?.blob && (suppliedFile?.file || photo.pendingUpload)) {
      queuedFiles.push({
        path,
        file: photo.blob,
        userId: normalizedRow.user_id,
        bucket: suppliedFile?.bucket || 'portfolio-files',
        contentType: suppliedFile?.contentType || photo.type,
      })
    }
  }

  const item = await addPendingSync({
    localId,
    type: 'portfolio-upsert',
    userId: normalizedRow.user_id,
    row: normalizedRow,
    files: queuedFiles,
    status: 'pending',
  })

  if (navigator.onLine) {
    try {
      await syncPortfolioEntry(client, item)
      for (const file of item.files || []) {
        await savePortfolioPhoto(normalizedRow.user_id, file.path, file.file, { pendingUpload: false })
      }
      await removePendingSync(localId, normalizedRow.updated_at)
      window.dispatchEvent(new CustomEvent('portfolio-sync-needed', {
        detail: { synced: true },
      }))
      return { error: null, synced: true }
    } catch (error) {
      console.error('Portfolio save is queued for retry:', error)
      if (error?.code === 'PORTFOLIO_CONFLICT') {
        await addPendingSync({
          ...item,
          status: 'conflict',
          conflictAt: new Date().toISOString(),
        })
      }
    }
  }

  window.dispatchEvent(new Event('portfolio-sync-needed'))
  return { error: null, synced: false, queued: true }
}

export async function syncPendingPortfolioEntry(client, item) {
  await syncPortfolioEntry(client, item)
  for (const file of item.files || []) {
    await savePortfolioPhoto(item.userId, file.path, file.file, { pendingUpload: false })
  }
}

export async function addPendingSync(item) {
  const db = await openDatabase()
  const record = {
    localId: item.localId || globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    createdAt: item.createdAt || new Date().toISOString(),
    ...item,
  }

  await new Promise((resolve, reject) => {
    const transaction = db.transaction(QUEUE_STORE, 'readwrite')
    const store = transaction.objectStore(QUEUE_STORE)
    store.put(record)
    transaction.oncomplete = resolve
    transaction.onerror = () => reject(transaction.error)
  })

  return record
}

export async function getPendingSync(userId) {
  const db = await openDatabase()
  const transaction = db.transaction(QUEUE_STORE, 'readonly')
  const store = transaction.objectStore(QUEUE_STORE)

  return new Promise((resolve, reject) => {
    const request = userId
      ? store.index('userId').getAll(userId)
      : store.getAll()

    request.onsuccess = () => {
      resolve((request.result || []).sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
    }
    request.onerror = () => reject(request.error)
  })
}

export async function removePendingSync(localId, expectedUpdatedAt) {
  const db = await openDatabase()
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(QUEUE_STORE, 'readwrite')
    const store = transaction.objectStore(QUEUE_STORE)
    if (expectedUpdatedAt) {
      const request = store.get(localId)
      request.onsuccess = () => {
        if (request.result?.row?.updated_at === expectedUpdatedAt) {
          store.delete(localId)
        }
      }
      request.onerror = () => reject(request.error)
    } else {
      store.delete(localId)
    }
    transaction.oncomplete = resolve
    transaction.onerror = () => reject(transaction.error)
  })
}

export async function clearOfflineUserData(userId) {
  const db = await openDatabase()
  await Promise.all([
    new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.getAllKeys()

      request.onsuccess = () => {
        for (const key of request.result || []) {
          if (typeof key === 'string' && key.startsWith(`portfolio:${userId}:`)) {
            store.delete(key)
          }
        }
      }
      transaction.oncomplete = resolve
      transaction.onerror = () => reject(transaction.error)
    }),
    new Promise((resolve, reject) => {
      const transaction = db.transaction(QUEUE_STORE, 'readwrite')
      const store = transaction.objectStore(QUEUE_STORE)
      const request = store.index('userId').getAllKeys(userId)

      request.onsuccess = () => {
        for (const localId of request.result || []) {
          store.delete(localId)
        }
      }
      transaction.oncomplete = resolve
      transaction.onerror = () => reject(transaction.error)
    }),
  ])
}