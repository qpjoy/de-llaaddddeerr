import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PROVINCE_ANALYSIS_FIELDS,
  buildProvinceAnalysisContext,
  runProvinceAnalysisGraph,
} from '../../server/agent/province-analysis-graph.mjs'

function claim(input, overrides = {}) {
  return {
    input,
    promptVersion: 'province-analysis.test',
    ...overrides,
  }
}

function assertionFor(assertions, fieldKey) {
  return assertions.find((assertion) => assertion.fieldKey === fieldKey)
}

test('maritime evidence sets geographic scope without inventing an event province', () => {
  const context = buildProvinceAnalysisContext({
    raw_payload: {
      title: '海警在南海海域开展常态化巡航',
      summary: '相关行动在海域内持续进行。',
      source_name: '中央新闻',
    },
  })

  assert.equal(assertionFor(context.assertions, PROVINCE_ANALYSIS_FIELDS.eventAdmin1), undefined)
  assert.deepEqual(
    assertionFor(context.assertions, PROVINCE_ANALYSIS_FIELDS.geoScope),
    {
      fieldKey: PROVINCE_ANALYSIS_FIELDS.geoScope,
      value: 'maritime',
      method: 'rule',
      confidence: 0.9,
      evidenceRefs: [{ path: 'event_text', quote: '南海' }],
      status: 'proposed',
    },
  )
  assert.equal(context.needsAgent, false)
})

test('Taiwan Strait and Hainan Prefecture text do not become false event provinces', () => {
  const strait = buildProvinceAnalysisContext({
    raw_payload: {
      title: '台湾海峡海域开展常态化巡航',
      source_name: '综合资讯',
    },
  })
  const prefecture = buildProvinceAnalysisContext({
    raw_payload: {
      title: '海南州发布道路结冰预警',
      source_name: '综合资讯',
    },
  })

  assert.equal(assertionFor(strait.assertions, PROVINCE_ANALYSIS_FIELDS.eventAdmin1), undefined)
  assert.equal(assertionFor(strait.assertions, PROVINCE_ANALYSIS_FIELDS.geoScope).value, 'maritime')
  assert.equal(assertionFor(prefecture.assertions, PROVINCE_ANALYSIS_FIELDS.eventAdmin1), undefined)
  assert.equal(prefecture.needsAgent, true)
})

test('a Jiangsu media name is publisher province evidence only', () => {
  const context = buildProvinceAnalysisContext({
    raw_payload: {
      title: '产业升级观察：制造业信心持续恢复',
      summary: '报道梳理了近期行业数据。',
      source_name: '江苏新闻',
    },
  })

  assert.equal(assertionFor(context.assertions, PROVINCE_ANALYSIS_FIELDS.eventAdmin1), undefined)
  assert.equal(
    assertionFor(context.assertions, PROVINCE_ANALYSIS_FIELDS.publisherAdmin1)?.value,
    'CN-JS',
  )
  assert.equal(
    assertionFor(context.assertions, PROVINCE_ANALYSIS_FIELDS.publisherAdmin1)?.evidenceRefs[0].path,
    'source_name',
  )
  assert.equal(assertionFor(context.assertions, PROVINCE_ANALYSIS_FIELDS.geoScope)?.value, 'unknown')
})

test('a prefecture publisher name wins over an overlapping province short name', () => {
  const context = buildProvinceAnalysisContext({
    raw_payload: {
      title: '当地发布道路结冰预警',
      source_name: '海南州融媒体中心',
    },
  })

  assert.equal(
    assertionFor(context.assertions, PROVINCE_ANALYSIS_FIELDS.publisherAdmin1)?.value,
    'CN-QH',
  )
  assert.notEqual(
    assertionFor(context.assertions, PROVINCE_ANALYSIS_FIELDS.publisherAdmin1)?.value,
    'CN-HI',
  )
})

test('an explicit source province is accepted without calling the Agent', async () => {
  let calls = 0
  const result = await runProvinceAnalysisGraph({
    claim: claim({
      raw_payload: {
        province: '江苏省',
        title: '重点项目建设进度公布',
        source_name: '综合信息平台',
      },
    }),
    agent: {
      available: true,
      async complete() {
        calls += 1
        throw new Error('the Agent must not be called for explicit source evidence')
      },
    },
  })

  assert.equal(calls, 0)
  assert.equal(result.summary.usedAgent, false)
  assert.equal(result.providerId, null)
  assert.deepEqual(
    assertionFor(result.assertions, PROVINCE_ANALYSIS_FIELDS.eventAdmin1),
    {
      fieldKey: PROVINCE_ANALYSIS_FIELDS.eventAdmin1,
      value: 'CN-JS',
      method: 'source',
      confidence: 1,
      evidenceRefs: [{ path: 'raw.province', quote: '江苏省' }],
      status: 'accepted',
    },
  )
})

test('ambiguous analysis sends only compact selected fields, never the whole raw payload', async () => {
  const secretSentinel = 'raw-field-must-never-reach-the-agent'
  let userContent = null
  const result = await runProvinceAnalysisGraph({
    claim: claim({
      raw_payload: {
        title: '行业运行情况更新',
        summary: '多个指标较上期有所改善。',
        source_name: '行业观察网',
        source_type: 'media',
        platform: 'public_opinion',
        ignored_blob: { secret: secretSentinel, repeated: 'x'.repeat(2_000) },
        raw: { unselected: secretSentinel },
      },
    }),
    agent: {
      available: true,
      async complete(messages) {
        userContent = messages[1].content
        return {
          provider: 'test-provider',
          model: 'test-model',
          attempts: [],
          payload: {
            choices: [{
              message: {
                content: JSON.stringify({
                  eventAdmin1Code: null,
                  eventConfidence: 0,
                  eventEvidenceText: '',
                  publisherAdmin1Code: null,
                  publisherConfidence: 0,
                  publisherEvidenceText: '',
                  geoScope: 'unknown',
                  scopeConfidence: 1,
                  scopeEvidenceText: '',
                }),
              },
            }],
          },
        }
      },
    },
  })

  const compact = JSON.parse(userContent)
  assert.deepEqual(Object.keys(compact).sort(), [
    'contentExcerpts',
    'deterministicCandidates',
    'existingClassification',
    'source',
    'structuredLocations',
    'summary',
    'title',
  ])
  assert.equal(userContent.includes(secretSentinel), false)
  assert.equal(userContent.includes('ignored_blob'), false)
  assert.equal(userContent.includes('raw_payload'), false)
  assert.equal(result.summary.usedAgent, true)
  assert.equal(result.summary.promptCharacters, userContent.length)
  assert.equal(
    result.assertions.filter((assertion) => assertion.method === 'agent')
      .every((assertion) => assertion.status === 'proposed'),
    true,
  )
})

test('bounded structured city evidence maps deterministically without spending an Agent call', async () => {
  let calls = 0
  const input = {
    raw_payload: {
      title: '当地发布最新处置通报',
      city: '南京市',
      ignored_blob: 'x'.repeat(4_000),
    },
  }
  const context = buildProvinceAnalysisContext(input)
  const result = await runProvinceAnalysisGraph({
    claim: claim(input),
    agent: {
      available: true,
      async complete() {
        calls += 1
        throw new Error('structured prefecture evidence must not call the Agent')
      },
    },
  })

  assert.equal(calls, 0)
  assert.equal(context.needsAgent, false)
  assert.deepEqual(context.compact.structuredLocations, [{ path: 'city', value: '南京市' }])
  const event = result.assertions.find((item) => (
    item.method === 'rule' && item.fieldKey === PROVINCE_ANALYSIS_FIELDS.eventAdmin1
  ))
  assert.equal(event.value, 'CN-JS')
  assert.equal(event.status, 'proposed')
  assert.deepEqual(event.evidenceRefs, [{ path: 'city', quote: '南京市' }])
  assert.equal(assertionFor(result.assertions, PROVINCE_ANALYSIS_FIELDS.geoScope)?.value, 'province')
})

test('conflicting structured location signals require Agent analysis instead of first-match selection', () => {
  const context = buildProvinceAnalysisContext({
    raw_payload: {
      title: '当地发布最新处置通报',
      city: '南京',
      adcode: '110000',
    },
  })

  assert.equal(assertionFor(context.assertions, PROVINCE_ANALYSIS_FIELDS.eventAdmin1), undefined)
  assert.equal(context.needsAgent, true)
  assert.deepEqual(context.compact.structuredLocations, [
    { path: 'city', value: '南京' },
    { path: 'adcode', value: '110000' },
  ])
})

test('Agent publisher code must respect a more specific prefecture name', async () => {
  await assert.rejects(
    runProvinceAnalysisGraph({
      claim: claim({
        raw_payload: {
          title: '当地发布最新处置通报',
          source_name: '海南州融媒体中心',
        },
      }),
      agent: {
        available: true,
        async complete() {
          return {
            provider: 'primary',
            model: 'model-a',
            payload: { choices: [{ message: { content: JSON.stringify({
              eventAdmin1Code: null,
              eventConfidence: 0,
              eventEvidenceText: '',
              publisherAdmin1Code: 'CN-HI',
              publisherConfidence: 0.9,
              publisherEvidenceText: '海南州融媒体中心',
              geoScope: 'unknown',
              scopeConfidence: 1,
              scopeEvidenceText: '',
            }) } }] },
          }
        },
      },
    }),
    (error) => error?.code === 'agent_unverified_evidence',
  )
})

test('Agent province code must match the meaning of its cited structured evidence', async () => {
  await assert.rejects(
    runProvinceAnalysisGraph({
      claim: claim({
        raw_payload: {
          title: '当地发布最新处置通报',
          city: '玄武区',
        },
      }),
      agent: {
        available: true,
        async complete() {
          return {
            provider: 'deepseek-compatible',
            model: 'chat-model',
            payload: { choices: [{ message: { content: JSON.stringify({
              eventAdmin1Code: 'CN-BJ',
              eventConfidence: 0.9,
              eventEvidenceText: '玄武区',
              publisherAdmin1Code: null,
              publisherConfidence: 0,
              publisherEvidenceText: '',
              geoScope: 'province',
              scopeConfidence: 0.9,
              scopeEvidenceText: '玄武区',
            }) } }] },
          }
        },
      },
    }),
    (error) => error?.code === 'agent_unverified_evidence',
  )
})

test('Agent may propose a province from a verified free-text prefecture quote', async () => {
  const result = await runProvinceAnalysisGraph({
    claim: {
      promptVersion: 'province-analysis.v1',
      input: {
        title: '南京发布暴雨红色预警，多处道路实施临时管控',
        body: '',
        platform: 'news',
        content_type: 'news',
        raw_payload: {
          title: '南京发布暴雨红色预警，多处道路实施临时管控',
          source_name: '综合资讯',
          source_type: 'news',
          platform: 'news',
        },
      },
    },
    agent: {
      available: true,
      async complete() {
        return {
          provider: 'primary',
          model: 'model-a',
          payload: { choices: [{ message: { content: JSON.stringify({
            eventAdmin1Code: 'CN-JS',
            eventConfidence: 0.86,
            eventEvidenceText: '南京发布暴雨红色预警',
            publisherAdmin1Code: null,
            publisherConfidence: 0,
            publisherEvidenceText: '',
            geoScope: 'province',
            scopeConfidence: 0.86,
            scopeEvidenceText: '南京发布暴雨红色预警',
          }) } }] },
        }
      },
    },
  })

  const event = result.assertions.find((item) => (
    item.fieldKey === PROVINCE_ANALYSIS_FIELDS.eventAdmin1 && item.method === 'agent'
  ))
  assert.equal(event.value, 'CN-JS')
  assert.equal(event.status, 'proposed')
  assert.equal(result.summary.usedAgent, true)
})
