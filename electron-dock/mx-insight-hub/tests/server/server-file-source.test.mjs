import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createApp } from '../../server/app.mjs'
import { ExternalImporter } from '../../server/ingest/external/importer.mjs'
import { ServerFileReader } from '../../server/ingest/external/server-files.mjs'

const ADMIN_TOKEN = 'server-file-admin-token-with-at-least-32-bytes'

async function withServer(options, operation) {
  const app = createApp({
    service: {},
    store: {},
    adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN,
    logger: { error() {} },
    ...options,
  })
  const server = createServer(app)
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    return await operation(baseUrl)
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose))
  }
}

async function call(baseUrl, path, {
  method = 'GET',
  body,
  headers = {},
} = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { response, payload: await response.json() }
}

function adminHeaders() {
  return { 'x-mx-insight-admin-token': ADMIN_TOKEN }
}

async function withFileFixture(operation, body = 'id,title\n1,alpha\n') {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'mxih-server-source-')))
  const allowedRoot = join(temporary, 'allowed')
  const sourcePath = join(allowedRoot, 'reports', 'weekly.csv')
  await mkdir(join(allowedRoot, 'reports'), { recursive: true })
  await writeFile(sourcePath, body)
  const reader = await ServerFileReader.create({ roots: { internal: allowedRoot } })
  try {
    return await operation({ temporary, allowedRoot, sourcePath, reader, body })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

function serverPathSource(overrides = {}) {
  return {
    id: 'source-id',
    sourceKey: 'weekly-server-file',
    displayName: 'Weekly server file',
    sourceKind: 'file',
    datasetId: 'external.weekly.v1',
    platform: 'external',
    objectType: 'record',
    status: 'active',
    connection: {
      fileMode: 'server_path',
      rootId: 'internal',
      relativePath: join('reports', 'weekly.csv'),
    },
    ...overrides,
  }
}

test('creating a server-path source stores only its safe locator', async () => {
  await withFileFixture(async ({ allowedRoot, sourcePath, reader }) => {
    let createdInput = null
    const store = {
      getExternalSource: async () => null,
      createExternalSource: async (input) => {
        createdInput = input
        return { id: 'created-source', ...input }
      },
    }

    await withServer({ store, serverFileReader: reader }, async (baseUrl) => {
      const result = await call(baseUrl, '/internal/v1/admin/sources', {
        method: 'POST',
        headers: adminHeaders(),
        body: {
          sourceKey: 'weekly-server-file',
          displayName: 'Weekly server file',
          sourceKind: 'file',
          fileMode: 'server_path',
          serverPath: sourcePath,
        },
      })

      assert.equal(result.response.status, 201)
      assert.deepEqual(createdInput.connection, {
        fileMode: 'server_path',
        rootId: 'internal',
        relativePath: join('reports', 'weekly.csv'),
      })
      assert.equal(JSON.stringify(createdInput).includes(allowedRoot), false)
      assert.equal(JSON.stringify(result.payload).includes(allowedRoot), false)
      assert.deepEqual(result.payload.data.connection, createdInput.connection)
    })
  })
})

test('server-file roots remain Admin Token-only and never disclose mount paths', async () => {
  await withFileFixture(async ({ allowedRoot, reader }) => {
    const identity = {
      enabled: true,
      resolve: async (credential) => credential === 'launcher-platform-admin'
        ? { kind: 'launcher', platformAdmin: true, tenantIds: null, capabilities: [] }
        : null,
    }
    await withServer({ identity, serverFileReader: reader }, async (baseUrl) => {
      const anonymous = await call(baseUrl, '/internal/v1/admin/server-file-roots')
      assert.equal(anonymous.response.status, 401)

      const launcherAdmin = await call(baseUrl, '/internal/v1/admin/server-file-roots', {
        headers: { authorization: 'Bearer launcher-platform-admin' },
      })
      assert.equal(launcherAdmin.response.status, 403)
      assert.equal(launcherAdmin.payload.error.code, 'admin_token_required')

      const admin = await call(baseUrl, '/internal/v1/admin/server-file-roots', {
        headers: adminHeaders(),
      })
      assert.equal(admin.response.status, 200)
      assert.deepEqual(admin.payload.data, [{ rootId: 'internal' }])
      assert.equal(JSON.stringify(admin.payload).includes(allowedRoot), false)
    })

    await withServer({
      listenerMode: 'public',
      adminToken: null,
      serverFileReader: reader,
    }, async (baseUrl) => {
      const hidden = await call(baseUrl, '/internal/v1/admin/server-file-roots', {
        headers: adminHeaders(),
      })
      assert.equal(hidden.response.status, 404)
    })
  })
})

test('server preview reuses only the exact scoped approved format rule', async () => {
  await withFileFixture(async ({ allowedRoot, sourcePath, reader, body }) => {
    const importer = new ExternalImporter({ store: {} })
    const expectedPreview = await importer.preview(Buffer.from(body), 'weekly.csv')
    const formatRule = {
      ruleId: 'rule-id',
      ruleKey: 'file.weekly',
      displayName: 'Weekly CSV',
      versionId: 'rule-version-id',
      version: 3,
      schemaFingerprint: expectedPreview.schemaFingerprint,
      fieldMap: {
        // The rule may have been approved from a producer that used different
        // header casing. Exact structure matching is normalization-aware, but
        // the applied mapping must use this file's concrete parser columns.
        externalId: { from: 'ID' },
        title: { from: 'Title' },
      },
    }
    const lookups = []
    const observations = []
    const store = {
      getExternalSource: async () => serverPathSource(),
      findApprovedFileFormatRule: async (query) => {
        lookups.push(query)
        return query.schemaFingerprint === expectedPreview.schemaFingerprint ? formatRule : null
      },
      recordFileObservation: async (observation) => {
        observations.push(observation)
        return observation
      },
    }
    let agentCalls = 0

    await withServer({
      store,
      importer,
      serverFileReader: reader,
      agent: {
        suggestFieldMap: async () => {
          agentCalls += 1
          throw new Error('exact rule lookup should make Agent unnecessary')
        },
      },
    }, async (baseUrl) => {
      // serverPath is deliberately omitted: the registered rootId/relativePath
      // locator is the default and the absolute path must not enter the response.
      const matched = await call(
        baseUrl,
        '/internal/v1/admin/sources/weekly-server-file/server-preview',
        { method: 'POST', headers: adminHeaders(), body: { agent: true } },
      )
      assert.equal(matched.response.status, 200)
      assert.equal(matched.payload.data.matchedFormatRule.versionId, formatRule.versionId)
      assert.equal(matched.payload.data.suggestion.origin, 'format_rule')
      assert.deepEqual(matched.payload.data.suggestion.fieldMap, {
        externalId: { from: 'id' },
        title: { from: 'title' },
      })
      assert.equal(typeof matched.payload.data.fileStructure.parserVersion, 'string')
      assert.equal(matched.payload.data.agentDataScope, 'none')
      assert.equal(agentCalls, 0)
      assert.deepEqual(lookups[0], {
        schemaFingerprint: expectedPreview.schemaFingerprint,
        datasetId: 'external.weekly.v1',
        platform: 'external',
        objectType: 'record',
      })
      assert.equal(JSON.stringify(matched.payload).includes(allowedRoot), false)
      assert.equal(JSON.stringify(matched.payload).includes(sourcePath), false)
      assert.equal(observations[0].rootId, 'internal')
      assert.equal(observations[0].relativePath, join('reports', 'weekly.csv'))
      assert.equal(observations[0].formatRuleVersionId, formatRule.versionId)

      const differentPath = join(allowedRoot, 'reports', 'different.csv')
      await writeFile(differentPath, 'uuid,body\na,message\n')
      const unmatched = await call(
        baseUrl,
        '/internal/v1/admin/sources/weekly-server-file/server-preview',
        {
          method: 'POST',
          headers: adminHeaders(),
          body: { serverPath: differentPath, agent: false },
        },
      )
      assert.equal(unmatched.response.status, 200)
      assert.equal(unmatched.payload.data.matchedFormatRule, null)
      assert.equal(unmatched.payload.data.suggestion.origin, 'inferred')
      assert.notEqual(unmatched.payload.data.schemaFingerprint, expectedPreview.schemaFingerprint)
      assert.equal(JSON.stringify(unmatched.payload).includes(allowedRoot), false)

      const invalidPathType = await call(
        baseUrl,
        '/internal/v1/admin/sources/weekly-server-file/server-preview',
        {
          method: 'POST',
          headers: adminHeaders(),
          body: { serverPath: 123 },
        },
      )
      assert.equal(invalidPathType.response.status, 400)
      assert.equal(invalidPathType.payload.error.code, 'invalid_server_file_path')
    })
  })
})

test('approving a server-path mapping uses the same source lock as import', async () => {
  const locks = []
  let approveOptions
  const source = serverPathSource()
  const store = {
    getExternalSource: async () => source,
    approveSourceMapping: async (input, options) => {
      approveOptions = options
      return { id: 'mapping-id', approved: true, ...input }
    },
  }
  const databasePuller = {
    withSourceLocks: async (keys, operation) => {
      locks.push(keys)
      return operation(async () => {}, [{ name: 'held-lock-session' }])
    },
  }

  await withServer({ store, databasePuller }, async (baseUrl) => {
    const result = await call(
      baseUrl,
      '/internal/v1/admin/sources/weekly-server-file/mappings/2/approve',
      { method: 'POST', headers: adminHeaders(), body: {} },
    )
    assert.equal(result.response.status, 200)
    assert.deepEqual(locks, [['weekly-server-file']])
    assert.equal(approveOptions.sessionClient.name, 'held-lock-session')
    assert.equal(result.payload.data.version, 2)
  })
})

test('expectedSha256 mismatch stops before structure parsing or import', async () => {
  await withFileFixture(async ({ allowedRoot, reader }) => {
    let previewCalls = 0
    let importCalls = 0
    let observationCalls = 0
    const store = {
      getExternalSource: async () => serverPathSource(),
      getActiveMapping: async () => ({ schemaFingerprint: 'a'.repeat(64) }),
      recordFileObservation: async () => { observationCalls += 1 },
    }
    const importer = {
      preview: async () => { previewCalls += 1 },
      importFile: async () => { importCalls += 1 },
    }
    const databasePuller = {
      withSourceLocks: async (keys, operation) => {
        assert.deepEqual(keys, ['weekly-server-file'])
        return operation(async () => {}, [{ name: 'held-lock-session' }])
      },
    }

    await withServer({ store, importer, databasePuller, serverFileReader: reader }, async (baseUrl) => {
      const result = await call(
        baseUrl,
        '/internal/v1/admin/sources/weekly-server-file/server-import',
        {
          method: 'POST',
          headers: adminHeaders(),
          body: { expectedSha256: '0'.repeat(64) },
        },
      )
      assert.equal(result.response.status, 409)
      assert.equal(result.payload.error.code, 'server_file_changed')
      assert.equal(previewCalls, 0)
      assert.equal(importCalls, 0)
      assert.equal(observationCalls, 0)
      assert.equal(JSON.stringify(result.payload).includes(allowedRoot), false)
    })
  })
})

test('default locator import returns only rootId and relativePath', async () => {
  await withFileFixture(async ({ allowedRoot, sourcePath, reader, body }) => {
    const inputSha256 = createHash('sha256').update(body).digest('hex')
    const schemaFingerprint = 'b'.repeat(64)
    const observations = []
    let importedInput = null
    const store = {
      getExternalSource: async () => serverPathSource(),
      getActiveMapping: async () => ({
        version: 1,
        schemaFingerprint,
        formatRuleVersionId: 'format-rule-version',
      }),
      recordFileObservation: async (observation) => {
        observations.push(observation)
        return observation
      },
    }
    const importer = {
      preview: async () => ({ schemaFingerprint }),
      importFile: async (input) => {
        importedInput = input
        return { status: 'succeeded', importRunId: 'import-run', ingested: 1, rejected: 0 }
      },
    }
    const databasePuller = {
      withSourceLocks: async (_keys, operation) => (
        operation(async () => {}, [{ name: 'held-lock-session' }])
      ),
    }

    await withServer({ store, importer, databasePuller, serverFileReader: reader }, async (baseUrl) => {
      const result = await call(
        baseUrl,
        '/internal/v1/admin/sources/weekly-server-file/server-import',
        {
          method: 'POST',
          headers: adminHeaders(),
          body: { expectedSha256: inputSha256 },
        },
      )
      assert.equal(result.response.status, 201)
      assert.deepEqual(result.payload.data.file, {
        rootId: 'internal',
        relativePath: join('reports', 'weekly.csv'),
      })
      assert.equal(JSON.stringify(result.payload).includes(allowedRoot), false)
      assert.equal(JSON.stringify(result.payload).includes(sourcePath), false)
      assert.equal(importedInput.filename, 'weekly.csv')
      assert.equal(importedInput.buffer.toString('utf8'), body)
      assert.equal(observations[0].relativePath, join('reports', 'weekly.csv'))
      assert.equal(JSON.stringify(observations[0]).includes(allowedRoot), false)
    })
  })
})
