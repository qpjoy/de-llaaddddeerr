import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowClockwise,
  ArrowRight,
  ArrowSquareOut,
  CaretRight,
  CheckCircle,
  Funnel,
  List,
  MagnifyingGlass,
  MapPin,
  MapTrifold,
  Package,
  PencilSimple,
  Storefront,
  WarningCircle,
} from '@phosphor-icons/react'
import { adminApi } from './api.js'
import {
  ConfirmDialog,
  DropdownField,
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  StatusBadge,
  useRemoteData,
} from './components.jsx'

const FLOOR_ASSET = 'assets/virtual-supermarket/supermarket-floor.webp'
const AISLE_ASSET = 'assets/virtual-supermarket/supermarket-aisle.webp'
const UNVERIFIED_PRODUCT_ASSET = 'assets/virtual-supermarket/products/unverified-product.webp'

const MODE_OPTIONS = [
  { value: 'browse', label: '逛超市', icon: Storefront },
  { value: 'panorama', label: '超市全景', icon: MapTrifold },
  { value: 'catalog', label: '目录模式', icon: List },
]
const MODE_VALUES = new Set(MODE_OPTIONS.map((option) => option.value))
const STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'on_shelf', label: '已上架' },
  { value: 'off_shelf', label: '已下架' },
]
const SORT_OPTIONS = [
  { value: 'newest', label: '最近采集' },
  { value: 'title_asc', label: '标题 A–Z' },
  { value: 'price_asc', label: '价格从低到高' },
  { value: 'price_desc', label: '价格从高到低' },
]
const NUMBER_FORMATTER = new Intl.NumberFormat('zh-CN')
const INVENTORY_CONFLICT_CODES = new Set([
  'storefront_revision_changed',
  'virtual_supermarket_inventory_changed',
])

function isInventoryConflict(error) {
  return INVENTORY_CONFLICT_CODES.has(error?.code)
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function formatNumber(value, fallback = '—') {
  if (value == null || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) ? NUMBER_FORMATTER.format(number) : fallback
}

function formatDateTime(value) {
  if (!value) return '时间未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(date)
}

function formatPrice(price) {
  const sourceDisplay = price?.display == null ? '' : String(price.display).trim()
  if (!price || price.amount == null || price.amount === '') {
    return price?.provenance === 'source' && sourceDisplay
      ? `源价 ${sourceDisplay} · 币种未确认`
      : '价格待核验'
  }
  const amount = String(price.amount)
  const currency = String(price.currency || '').toUpperCase()
  if (price.provenance === 'source') {
    return currency
      ? `源价 ${sourceDisplay || amount} · ${currency}`
      : `源价 ${sourceDisplay || amount} · 币种未确认`
  }
  if (currency === 'CNY') return `¥ ${amount}`
  if (currency) return `${currency} ${amount}`
  return `${amount} · 币种未确认`
}

function mediaUrl(item) {
  const media = item?.product?.media ?? item?.media
  const first = Array.isArray(media) ? media[0] : media
  const candidate = typeof first === 'string' ? first : first?.url
  return typeof candidate === 'string' && (candidate.startsWith('/') || /^https:\/\//u.test(candidate))
    ? candidate
    : UNVERIFIED_PRODUCT_ASSET
}

function normalizedCategory(raw, index = 0) {
  const category = asObject(raw)
  const department = asObject(category.department)
  const aisle = asObject(category.aisle)
  const shelf = asObject(category.shelf)
  return {
    id: String(category.id ?? category.categoryId ?? category.key ?? `category-${index}`),
    key: String(category.key ?? category.id ?? `category-${index}`),
    name: String(category.name ?? category.label ?? shelf.name ?? '待分类'),
    sortOrder: finiteNumber(category.sortOrder, index),
    revision: finiteNumber(category.revision, 1),
    department: {
      key: String(department.key ?? category.departmentKey ?? 'uncategorized'),
      name: String(department.name ?? category.departmentName ?? '待分类'),
      sortOrder: finiteNumber(department.sortOrder ?? category.departmentSortOrder, index),
    },
    aisle: {
      key: String(aisle.key ?? category.aisleKey ?? 'unassigned'),
      name: String(aisle.name ?? category.aisleName ?? '待分配通道'),
      sortOrder: finiteNumber(aisle.sortOrder ?? category.aisleSortOrder, index),
    },
    shelf: {
      key: String(shelf.key ?? category.shelfKey ?? category.key ?? 'unassigned'),
      name: String(shelf.name ?? category.shelfName ?? category.name ?? '待分配货架'),
      sortOrder: finiteNumber(shelf.sortOrder ?? category.shelfSortOrder ?? category.sortOrder, index),
    },
    total: finiteNumber(category.total ?? category.productCount ?? category.count),
    onShelf: finiteNumber(category.onShelf ?? category.onShelfCount ?? category.publishedCount),
  }
}

function normalizeProduct(raw) {
  if (!raw) return null
  const item = asObject(raw.item ?? raw)
  const listing = asObject(item.listing)
  const product = asObject(item.product)
  const sourceEvidence = asObject(item.sourceEvidence)
  const fieldState = asObject(item.fieldState)
  const marketplace = asObject(item.marketplace)
  const shop = asObject(item.shop)
  const placement = asObject(item.placement)
  const categoryRecord = asObject(item.category ?? placement.category)
  const category = normalizedCategory({
    ...categoryRecord,
    id: categoryRecord.id ?? item.categoryId,
    department: categoryRecord.department ?? item.department ?? placement.department,
    aisle: categoryRecord.aisle ?? item.aisle ?? placement.aisle,
    shelf: categoryRecord.shelf ?? item.shelf ?? placement.shelf,
  })
  const status = String(listing.status ?? item.status ?? 'off_shelf') === 'on_shelf'
    ? 'on_shelf'
    : 'off_shelf'
  return {
    raw: item,
    id: String(item.id ?? item.productId ?? item.canonicalId ?? ''),
    dataVersion: String(item.dataVersion ?? item.sourceRevision ?? '—'),
    revision: finiteNumber(listing.revision ?? item.listingRevision ?? item.revision),
    explicit: Boolean(listing.explicit),
    status,
    title: String(product.title ?? item.title ?? '未命名商品'),
    specification: product.specification ?? item.specification ?? null,
    brand: product.brand ?? item.brand ?? null,
    price: asObject(product.price ?? item.price),
    provenance: product.provenance ?? item.provenance ?? null,
    fieldState: {
      title: asObject(fieldState.displayTitle),
      specification: asObject(fieldState.specification),
      price: asObject(fieldState.price),
      currency: asObject(fieldState.currency),
    },
    sourceFields: {
      title: fieldState.displayTitle?.source ?? sourceEvidence.title ?? null,
      specification: fieldState.specification?.source ?? null,
      price: fieldState.price?.source ?? sourceEvidence.price ?? null,
      currency: fieldState.currency?.source ?? null,
    },
    listingOverrides: {
      title: fieldState.displayTitle?.override ?? listing.displayTitle ?? null,
      specification: fieldState.specification?.override ?? listing.specification ?? null,
      price: listing.price == null ? null : asObject(listing.price),
    },
    marketplaceKey: String(marketplace.key ?? marketplace.sourceKey ?? item.platform ?? 'unknown'),
    marketplaceName: String(marketplace.name ?? marketplace.canonicalName ?? marketplace.sourceValue ?? item.platform ?? '来源未知'),
    shopName: String(shop.name ?? item.shopName ?? '店铺未知'),
    collectedAt: item.collectedAt ?? product.price?.observedAt ?? item.observedAt ?? null,
    categoryId: category.id,
    categoryName: category.name,
    departmentKey: category.department.key,
    departmentName: category.department.name,
    aisleKey: category.aisle.key,
    aisleName: category.aisle.name,
    shelfKey: category.shelf.key,
    shelfName: category.shelf.name,
    position: placement.position ?? item.position ?? item.shelfPosition ?? listing.position ?? null,
    imageUrl: mediaUrl(item),
    hasVerifiedMedia: mediaUrl(item) !== UNVERIFIED_PRODUCT_ASSET,
  }
}

function categoryItems(metadata, categoriesResponse) {
  const candidates = categoriesResponse?.items
    ?? categoriesResponse?.categories
    ?? metadata?.categories
    ?? metadata?.taxonomy?.categories
    ?? []
  return Array.isArray(candidates) ? candidates.map(normalizedCategory) : []
}

function groupDepartments(categories, products) {
  const productCounts = new Map()
  for (const product of products) {
    const counts = productCounts.get(product.categoryId) || { total: 0, onShelf: 0 }
    counts.total += 1
    if (product.status === 'on_shelf') counts.onShelf += 1
    productCounts.set(product.categoryId, counts)
  }
  const fallbackMap = new Map()
  for (const [index, product] of products.entries()) {
    const category = normalizedCategory(product.raw?.category ?? {
      id: product.categoryId,
      name: product.categoryName,
      department: { key: product.departmentKey, name: product.departmentName },
      aisle: { key: product.aisleKey, name: product.aisleName },
      shelf: { key: product.shelfKey, name: product.shelfName },
    }, index)
    const existing = fallbackMap.get(category.id)
    if (existing) {
      existing.total += 1
      if (product.status === 'on_shelf') existing.onShelf += 1
    } else {
      fallbackMap.set(category.id, {
        ...category,
        total: 1,
        onShelf: product.status === 'on_shelf' ? 1 : 0,
      })
    }
  }
  const fallback = [...fallbackMap.values()]
  const source = categories.length ? categories.map((category) => {
    const counts = productCounts.get(category.id)
    return counts ? {
      ...category,
      total: Math.max(category.total, counts.total),
      onShelf: Math.max(category.onShelf, counts.onShelf),
    } : category
  }) : fallback
  const map = new Map()
  for (const category of source) {
    const key = category.department.key
    if (!map.has(key)) {
      map.set(key, {
        key,
        name: category.department.name,
        sortOrder: category.department.sortOrder,
        total: 0,
        onShelf: 0,
        categories: [],
      })
    }
    const department = map.get(key)
    department.categories.push(category)
    department.total += category.total
    department.onShelf += category.onShelf
  }
  return [...map.values()]
    .map((department) => ({
      ...department,
      categories: department.categories.sort((left, right) => (
        left.aisle.sortOrder - right.aisle.sortOrder
        || left.shelf.sortOrder - right.shelf.sortOrder
        || left.name.localeCompare(right.name, 'zh-CN')
      )),
    }))
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'zh-CN'))
}

function ProductImage({ product, className = '' }) {
  return (
    <span className={`mih-market-product-image ${className}`.trim()}>
      <img src={product?.imageUrl || UNVERIFIED_PRODUCT_ASSET} alt={product?.hasVerifiedMedia ? product.title : ''} />
      {!product?.hasVerifiedMedia ? <small>中性示意图</small> : null}
    </span>
  )
}

function ListingBadge({ product }) {
  const onShelf = product?.status === 'on_shelf'
  return <StatusBadge status={onShelf ? 'active' : 'disabled'} label={onShelf ? '已上架' : '已下架'} />
}

function DepartmentNavigation({ departments, products, selectedCategoryId, activeDepartmentKey, onSelectCategory, onReset }) {
  const total = departments.reduce((sum, item) => sum + item.total, 0) || products.length
  return (
    <nav className="qp-panel mih-market-departments" aria-label="虚拟超市部门导航">
      <header>
        <strong>部门导航</strong>
        <span>{formatNumber(total)} 件</span>
      </header>
      <button className={!selectedCategoryId && !activeDepartmentKey ? 'is-active' : ''} type="button" onClick={onReset}>
        <span>全部商品</span><strong>{formatNumber(total)}</strong>
      </button>
      <div className="mih-market-departments__tree">
        {departments.map((department) => (
          <section key={department.key}>
            <header className={activeDepartmentKey === department.key ? 'is-active' : ''}>
              <span>{department.name}</span>
              <strong>{formatNumber(department.total)}</strong>
            </header>
            {department.categories.map((category) => (
              <button
                className={selectedCategoryId === category.id ? 'is-active' : ''}
                key={category.id}
                type="button"
                onClick={() => onSelectCategory(category)}
              >
                <CaretRight size={13} aria-hidden="true" />
                <span>{category.name}</span>
                <strong>{formatNumber(category.total)}</strong>
              </button>
            ))}
          </section>
        ))}
      </div>
    </nav>
  )
}

function CurrentPath({ category, products }) {
  return (
    <section className="qp-panel mih-market-current-path" aria-label="当前货架路径">
      <strong>当前路径</strong>
      <ol>
        <li>{category?.department.name || '全部部门'}</li>
        <li>{category?.aisle.name || '全部通道'}</li>
        <li>{category?.shelf.name || '全部货架'}</li>
      </ol>
      <dl>
        <div><dt>当前结果</dt><dd>{formatNumber(products.length)}</dd></div>
        <div><dt>已上架</dt><dd>{formatNumber(products.filter((item) => item.status === 'on_shelf').length)}</dd></div>
      </dl>
    </section>
  )
}

function ProductEvidence({ product, shelfProducts, loading, error, onRetry, onSelect, onEdit, onToggleListing, onEnterShelf }) {
  if (error) {
    return (
      <aside className="qp-panel mih-market-evidence" aria-label="商品证据加载失败">
        <ErrorState error={error} onRetry={onRetry} />
      </aside>
    )
  }
  if (loading) {
    return (
      <aside className="qp-panel mih-market-evidence" aria-label="正在加载商品证据">
        <LoadingState label="正在加载商品证据" />
      </aside>
    )
  }
  if (!product) {
    return (
      <aside className="qp-panel mih-market-evidence">
        <EmptyState icon={Package} title="尚未选择商品" description="从全景、货架或目录中选择商品后查看证据。" />
      </aside>
    )
  }
  const onShelf = product.status === 'on_shelf'
  return (
    <aside className="qp-panel mih-market-evidence" aria-label="选中商品证据">
      <header><strong>选中商品</strong><ListingBadge product={product} /></header>
      <section className="mih-market-evidence__hero">
        <ProductImage product={product} />
        <div>
          <h2>{product.title}</h2>
          <p>{product.specification || '规格尚未核验'}</p>
          <strong>{formatPrice(product.price)}</strong>
        </div>
      </section>
      {!product.hasVerifiedMedia ? (
        <p className="mih-market-media-note"><WarningCircle size={15} aria-hidden="true" />源端未提供已验证图片，当前图片仅作分类示意。</p>
      ) : null}
      <dl className="mih-market-evidence__facts">
        <div><dt>分类路径</dt><dd>{product.departmentName} / {product.aisleName} / {product.shelfName}</dd></div>
        <div><dt>货架位置</dt><dd>{product.shelfName} / {product.position ?? '待分配'}</dd></div>
        <div><dt>来源平台</dt><dd><span className="qp-tag">{product.marketplaceName}</span></dd></div>
        <div><dt>来源店铺</dt><dd>{product.shopName}</dd></div>
        <div><dt>观测时间</dt><dd>{formatDateTime(product.collectedAt)}</dd></div>
        <div><dt>数据版本</dt><dd className="mih-mono">{product.dataVersion}</dd></div>
        <div><dt>展示状态</dt><dd><ListingBadge product={product} /></dd></div>
      </dl>
      <section className="mih-market-shelf-preview">
        <header><strong>{product.shelfName}</strong><span>{formatNumber(shelfProducts.length)} 件当前结果</span></header>
        <div>
          {shelfProducts.slice(0, 8).map((item) => (
            <button className={item.id === product.id ? 'is-active' : ''} key={item.id} type="button"
              aria-label={`选择 ${item.title}`} onClick={() => onSelect(item.id)}>
              <ProductImage product={item} />
            </button>
          ))}
        </div>
      </section>
      <div className="mih-market-evidence__actions">
        <button className="qp-button qp-button--primary" type="button" onClick={onEnterShelf}>
          <Storefront size={17} aria-hidden="true" />进入货架
        </button>
        <button className="qp-button qp-button--outline" type="button" onClick={() => onEdit(product)}>
          <PencilSimple size={17} aria-hidden="true" />编辑展示
        </button>
        <button className="qp-button qp-button--ghost" type="button" onClick={() => onToggleListing(product)}>
          {onShelf ? '下架商品' : '上架商品'}
        </button>
        <a className="qp-button qp-button--ghost" href="#/data-center?datasetId=mobile-commerce.collected-items.v1">
          查看数据证据<ArrowSquareOut size={15} aria-hidden="true" />
        </a>
      </div>
      <small className="mih-market-evidence__policy">上架与下架仅影响 Hub 商店展示，不会删除源数据证据。</small>
    </aside>
  )
}

function shelfPeers(products, selected) {
  if (!selected) return []
  const peers = products.filter((item) => item.shelfKey === selected.shelfKey)
  return peers.length ? peers : products
}

function SpatialLoadStatus({ loadedCount, pageInfo, loading, error, onLoadMore }) {
  const total = Number(pageInfo?.total)
  const hasKnownTotal = Number.isFinite(total) && total >= 0
  const hasMore = Boolean(pageInfo?.hasMore && pageInfo?.nextCursor)
  const summary = !pageInfo
    ? `当前已加载 ${formatNumber(loadedCount)} 件 · 分页状态确认中`
    : hasKnownTotal
      ? `当前已加载 ${formatNumber(loadedCount)} / 共 ${formatNumber(total)} 件`
      : hasMore
        ? `当前已加载 ${formatNumber(loadedCount)} 件 · 仍有更多`
        : `已加载 ${formatNumber(loadedCount)} 件 · 已到当前筛选结果末尾`
  return (
    <section className="qp-panel mih-market-load-more" aria-label="空间视图加载范围">
      <span role="status">{summary}</span>
      {error ? <small>加载更多失败：{error.message || '请求失败'}</small> : null}
      {hasMore ? (
        <button className="qp-button qp-button--outline qp-button--sm" type="button" disabled={loading} onClick={onLoadMore}>
          {loading ? '正在加载' : error ? '重试加载' : '继续加载'}
        </button>
      ) : null}
    </section>
  )
}

function PanoramaView({ departments, categories, products, selected, selectedCategory, actions, spatialPagination }) {
  const nodePositions = [
    { left: '18%', top: '24%' },
    { left: '58%', top: '16%' },
    { left: '66%', top: '42%' },
    { left: '24%', top: '56%' },
  ]
  return (
    <div className="mih-market-panorama">
      <div className="mih-market-spatial-canvas">
        <figure className="qp-panel mih-market-floor">
          <figcaption>
            <span>{selectedCategory ? `${selectedCategory.department.name} · ${selectedCategory.aisle.name}` : '虚拟超市全景'}</span>
            <strong>{selectedCategory?.shelf.name || '全部货架'}</strong>
            <small>{formatNumber(products.length)} 件已加载结果</small>
          </figcaption>
          <img src={FLOOR_ASSET} alt="从入口俯瞰虚拟超市各部门与货架的全景" />
          <div className="mih-market-floor__nodes" aria-label="全景部门快捷入口">
            {departments.slice(0, 4).map((department, index) => (
              <button key={department.key} type="button" style={nodePositions[index]}
                aria-label={`进入${department.name}部门（${formatNumber(department.total)}件已加载）`}
                onClick={() => actions.selectDepartment(department)}>
                <MapPin size={20} weight="fill" aria-hidden="true" />
                <span><strong>{department.name}</strong><small>{formatNumber(department.total)} 件</small></span>
              </button>
            ))}
          </div>
          <p className="mih-market-floor__hint"><MapPin size={16} aria-hidden="true" />点击部门标记进入，或在左侧选择具体货架</p>
        </figure>
        <SpatialLoadStatus {...spatialPagination} />
      </div>
      <div className="mih-market-panorama__rail">
        <DepartmentNavigation departments={departments} products={products}
          selectedCategoryId={selectedCategory?.id} activeDepartmentKey={selectedCategory?.department.key}
          onSelectCategory={actions.selectCategory} onReset={actions.resetCategory} />
        <CurrentPath category={selectedCategory} products={products} />
      </div>
      <ProductEvidence product={selected} shelfProducts={shelfPeers(products, selected)} {...actions.evidence} />
    </div>
  )
}

function ProductCard({ product, selected, onSelect }) {
  return (
    <button className={`mih-market-product-card${selected ? ' is-selected' : ''}${product.status === 'off_shelf' ? ' is-off-shelf' : ''}`}
      type="button" onClick={() => onSelect(product.id)} aria-pressed={selected}>
      <ProductImage product={product} />
      <span className="mih-market-product-card__copy">
        <strong>{product.title}</strong>
        <small>{product.specification || product.marketplaceName}</small>
        <span>{formatPrice(product.price)}</span>
      </span>
      <ListingBadge product={product} />
    </button>
  )
}

function BrowseView({ departments, products, selected, selectedCategory, actions, spatialPagination }) {
  const shelfGroups = useMemo(() => {
    const groups = new Map()
    for (const product of products) {
      const key = product.shelfKey || 'unassigned'
      if (!groups.has(key)) groups.set(key, { key, name: product.shelfName, items: [] })
      groups.get(key).items.push(product)
    }
    return [...groups.values()]
  }, [products])
  return (
    <div className="mih-market-browse">
      <div className="mih-market-panorama__rail">
        <DepartmentNavigation departments={departments} products={products}
          selectedCategoryId={selectedCategory?.id} activeDepartmentKey={selectedCategory?.department.key}
          onSelectCategory={actions.selectCategory} onReset={actions.resetCategory} />
        <CurrentPath category={selectedCategory} products={products} />
      </div>
      <main className="mih-market-aisles" aria-label="可操作商品货架">
        <figure className="qp-panel mih-market-aisle-hero">
          <img src={AISLE_ASSET} alt="虚拟超市衣物清洁货架通道" />
          <figcaption>
            <span>正在逛</span>
            <strong>{selectedCategory?.shelf.name || '全部货架'}</strong>
            <small>选择商品可查看采集证据与展示状态</small>
          </figcaption>
        </figure>
        {shelfGroups.length ? shelfGroups.map((group) => (
          <section className="qp-panel mih-market-shelf" key={group.key}>
            <header>
              <div><Storefront size={18} aria-hidden="true" /><span><strong>{group.name}</strong><small>{formatNumber(group.items.length)} 件当前结果</small></span></div>
              <button className="qp-button qp-button--ghost qp-button--sm" type="button"
                onClick={() => actions.select(group.items[0].id)}>从第一件开始<ArrowRight size={14} aria-hidden="true" /></button>
            </header>
            <div className="mih-market-shelf__products">
              {group.items.map((product) => <ProductCard key={product.id} product={product}
                selected={selected?.id === product.id} onSelect={actions.select} />)}
            </div>
          </section>
        )) : (
          <EmptyState icon={Storefront} title="当前货架没有商品" description="调整搜索或分类筛选后再试。" />
        )}
        <SpatialLoadStatus {...spatialPagination} />
      </main>
      <ProductEvidence product={selected} shelfProducts={shelfPeers(products, selected)} {...actions.evidence} />
    </div>
  )
}

function CatalogView({ products, selected, categories, status, sort, pageInfo, loading, actions }) {
  const categoryOptions = [{ value: 'all', label: '全部分类' }, ...categories.map((category) => ({
    value: category.id,
    label: `${category.department.name} / ${category.aisle.name} / ${category.shelf.name}`,
  }))]
  return (
    <section className="qp-panel mih-market-catalog" aria-label="虚拟超市商品目录">
      <header className="mih-market-catalog__filters">
        <div><Funnel size={18} aria-hidden="true" /><span><strong>商品目录</strong><small>搜索、筛选并管理展示字段与上架状态</small></span></div>
        <DropdownField label="上架状态" value={status} options={STATUS_OPTIONS} onChange={actions.setStatus} />
        <DropdownField label="商品分类" value={actions.categoryId || 'all'} options={categoryOptions} onChange={actions.setCategoryId} />
        <DropdownField label="排序" value={sort} options={SORT_OPTIONS} onChange={actions.setSort} />
      </header>
      {products.length ? (
        <div className="mih-table-wrap qp-scrollbar">
          <table className="mih-table mih-market-table">
            <thead><tr><th>商品</th><th>价格 / 规格</th><th>分类与货架</th><th>来源证据</th><th>状态</th><th><span className="mih-sr-only">操作</span></th></tr></thead>
            <tbody>
              {products.map((product) => (
                <tr className={selected?.id === product.id ? 'is-selected' : ''} key={product.id}>
                  <td><div className="mih-market-table__product"><ProductImage product={product} /><span><strong>{product.title}</strong><small>{product.brand || '品牌待核验'}</small></span></div></td>
                  <td><strong>{formatPrice(product.price)}</strong><small>{product.specification || '规格待核验'}</small></td>
                  <td><strong>{product.departmentName} / {product.aisleName}</strong><small>{product.shelfName} · 货位 {product.position ?? '待分配'}</small></td>
                  <td><strong>{product.marketplaceName}</strong><small>{formatDateTime(product.collectedAt)}</small></td>
                  <td><ListingBadge product={product} /></td>
                  <td className="mih-table__actions"><div className="mih-table__actions--wide">
                    <button className="qp-button qp-button--ghost qp-button--sm" type="button" onClick={() => actions.select(product.id)}>查看</button>
                    <button className="qp-button qp-button--outline qp-button--sm" type="button" onClick={() => actions.edit(product)}><PencilSimple size={14} aria-hidden="true" />编辑</button>
                    <button className="qp-button qp-button--ghost qp-button--sm" type="button" onClick={() => actions.toggle(product)}>{product.status === 'on_shelf' ? '下架' : '上架'}</button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <EmptyState icon={List} title="目录中没有匹配商品" description="调整状态、分类或搜索条件后再试。" />}
      <footer className="mih-market-catalog__pagination">
        <span>本页 {formatNumber(products.length)} 件 · {pageInfo?.nextCursor ? '还有下一页' : '已到末页'}{pageInfo?.storefrontRevision ? ` · 快照 ${pageInfo.storefrontRevision}` : ''}</span>
        <div>
          <button className="qp-button qp-button--ghost qp-button--sm" type="button" disabled={loading || !actions.canPrevious} onClick={actions.previousPage}>上一页</button>
          <strong>第 {actions.pageNumber} 页</strong>
          <button className="qp-button qp-button--ghost qp-button--sm" type="button" disabled={loading || !pageInfo?.nextCursor} onClick={() => actions.nextPage(pageInfo.nextCursor)}>下一页</button>
        </div>
      </footer>
    </section>
  )
}

function EditProductModal({ product, categories, busy, error, onClose, onSave }) {
  const titleRef = useRef(null)
  const initialForm = {
    titleOverride: product.listingOverrides.title || '',
    specificationOverride: product.listingOverrides.specification || '',
    priceAmount: product.listingOverrides.price?.amount == null ? '' : String(product.listingOverrides.price.amount),
    currency: product.listingOverrides.price?.currency || '',
    categoryId: product.categoryId || '',
    shelfPosition: product.position == null ? '' : String(product.position),
  }
  const [form, setForm] = useState(initialForm)
  const categoryOptions = categories.map((category) => ({
    value: category.id,
    label: `${category.department.name} / ${category.aisle.name} / ${category.shelf.name}`,
  }))
  const titleOverride = form.titleOverride.trim()
  const specificationOverride = form.specificationOverride.trim()
  const priceAmount = form.priceAmount.trim()
  const initialPriceAmount = initialForm.priceAmount.trim()
  const titleDirty = titleOverride !== initialForm.titleOverride.trim()
  const specificationDirty = specificationOverride !== initialForm.specificationOverride.trim()
  const priceDirty = priceAmount !== initialPriceAmount
    || (priceAmount && form.currency !== initialForm.currency)
  const priceInvalid = Boolean(priceAmount && !/^[A-Z]{3}$/u.test(form.currency))
  const categoryDirty = form.categoryId !== initialForm.categoryId
  const position = form.shelfPosition.trim() ? Number(form.shelfPosition) : null
  const initialPosition = initialForm.shelfPosition.trim() ? Number(initialForm.shelfPosition) : null
  const shelfPositionDirty = position !== initialPosition
  const hasChanges = titleDirty || specificationDirty || priceDirty || categoryDirty || shelfPositionDirty
  const submit = (event) => {
    event.preventDefault()
    onSave({
      expectedRevision: product.revision,
      ...(titleDirty ? { title: titleOverride || null } : {}),
      ...(specificationDirty ? { specification: specificationOverride || null } : {}),
      ...(priceDirty ? { price: priceAmount ? { amount: priceAmount, currency: form.currency } : null } : {}),
      ...(categoryDirty ? { categoryId: form.categoryId || null } : {}),
      ...(shelfPositionDirty ? { shelfPosition: position } : {}),
    })
  }
  return (
    <Modal title="编辑商品展示" description="修改 Hub 发布字段和语义货架位置；源采集证据保持不变。" size="large"
      busy={busy} initialFocusRef={titleRef} onClose={onClose}
      footer={<><button className="qp-button qp-button--ghost" type="button" disabled={busy} onClick={onClose}>取消</button><button className="qp-button qp-button--primary" type="submit" form="mih-market-edit-form" disabled={busy || !hasChanges || priceInvalid}>保存展示</button></>}>
      <form className="mih-market-edit" id="mih-market-edit-form" onSubmit={submit}>
        {error ? <ErrorState error={error} /> : null}
        <section className="mih-market-override-field">
          <header><span><strong>展示标题覆盖</strong><small>源值：{product.sourceFields.title || '源端未提供'}</small></span><button className="qp-button qp-button--ghost qp-button--sm" type="button" disabled={!form.titleOverride} onClick={() => setForm({ ...form, titleOverride: '' })}>恢复源值</button></header>
          <label className="qp-field"><span className="mih-sr-only">展示标题覆盖</span><input ref={titleRef} className="qp-input" value={form.titleOverride} maxLength={512} placeholder={product.sourceFields.title || '输入人工展示标题'} onChange={(event) => setForm({ ...form, titleOverride: event.target.value })} /></label>
        </section>
        <section className="mih-market-override-field">
          <header><span><strong>展示规格覆盖</strong><small>源值：{product.sourceFields.specification || '源端未提供；清除后不展示规格'}</small></span><button className="qp-button qp-button--ghost qp-button--sm" type="button" disabled={!form.specificationOverride} onClick={() => setForm({ ...form, specificationOverride: '' })}>清除人工覆盖</button></header>
          <label className="qp-field"><span className="mih-sr-only">展示规格覆盖</span><input className="qp-input" value={form.specificationOverride} maxLength={1000} placeholder="输入人工核验规格" onChange={(event) => setForm({ ...form, specificationOverride: event.target.value })} /></label>
        </section>
        <section className="mih-market-override-field">
          <header><span><strong>展示价格覆盖</strong><small>源值：{product.sourceFields.price == null ? '源端未提供' : `${product.sourceFields.price}（币种未确认）`}</small></span><button className="qp-button qp-button--ghost qp-button--sm" type="button" disabled={!form.priceAmount} onClick={() => setForm({ ...form, priceAmount: '', currency: '' })}>恢复源值</button></header>
          <div className="mih-market-edit__row">
            <label className="qp-field"><span className="qp-field__label">价格金额</span><input className="qp-input" inputMode="decimal" value={form.priceAmount} pattern="[0-9]+(?:\\.[0-9]{1,2})?" placeholder={product.sourceFields.price == null ? '输入人工价格' : String(product.sourceFields.price)} onChange={(event) => setForm({ ...form, priceAmount: event.target.value })} /></label>
            <label className="qp-field"><span className="qp-field__label">币种（ISO 4217）</span><input className="qp-input mih-mono" value={form.currency} maxLength={3} pattern="[A-Z]{3}" placeholder="例如 CNY" onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase() })} /><span className="qp-field__hint">{priceInvalid ? '人工价格必须填写三位大写币种代码。' : '源价币种未确认；这里只设置人工覆盖。'}</span></label>
          </div>
        </section>
        <div className="mih-market-edit__row">
          <DropdownField label="商品分类与货架" value={form.categoryId} options={categoryOptions} placeholder="选择部门 / 通道 / 货架" onChange={(categoryId) => setForm({ ...form, categoryId })} hint="分类同时决定 department / aisle / shelf 语义位置。" />
          <label className="qp-field"><span className="qp-field__label">货位顺序</span><input className="qp-input" type="number" min="0" step="1" value={form.shelfPosition} placeholder="待分配" onChange={(event) => setForm({ ...form, shelfPosition: event.target.value })} /><span className="qp-field__hint">同一货架内的陈列顺序，不是 3D 坐标。</span></label>
        </div>
        <p className="mih-market-edit__provenance">仅提交发生变化的字段；清空覆盖会发送 <code>null</code> 并恢复源值，不会把当前生效值固化为人工覆盖。</p>
      </form>
    </Modal>
  )
}

function CategoryManagerModal({ categories, loading, error, onClose, onCreate, onEdit }) {
  return (
    <Modal title="管理商品分类" description="维护虚拟超市的部门、通道和货架；分类不会物理删除。" size="large"
      onClose={onClose}
      footer={<><button className="qp-button qp-button--ghost" type="button" onClick={onClose}>关闭</button><button className="qp-button qp-button--primary" type="button" onClick={onCreate}>新建分类</button></>}>
      {error ? <ErrorState error={error} /> : null}
      {loading && !categories.length ? <LoadingState label="正在加载商品分类" /> : null}
      {categories.length ? (
        <div className="mih-table-wrap qp-scrollbar mih-market-category-table">
          <table className="mih-table">
            <thead><tr><th>分类</th><th>部门 / 通道 / 货架</th><th>排序</th><th>Revision</th><th><span className="mih-sr-only">操作</span></th></tr></thead>
            <tbody>{categories.map((category) => (
              <tr key={category.id}>
                <td><strong>{category.name}</strong><small className="mih-mono">{category.key}</small></td>
                <td><strong>{category.department.name} / {category.aisle.name}</strong><small>{category.shelf.name}</small></td>
                <td><strong>{formatNumber(category.sortOrder)}</strong><small>{category.department.sortOrder} / {category.aisle.sortOrder} / {category.shelf.sortOrder}</small></td>
                <td><strong>{formatNumber(category.revision)}</strong></td>
                <td className="mih-table__actions"><button className="qp-button qp-button--outline qp-button--sm" type="button" onClick={() => onEdit(category)}><PencilSimple size={14} aria-hidden="true" />编辑</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : !loading ? <EmptyState icon={Package} title="还没有商品分类" description="新建分类后即可将商品放入业务部门、通道和货架。" /> : null}
    </Modal>
  )
}

function categoryEditorForm(category) {
  return {
    key: category?.key || '',
    name: category?.name || '',
    departmentKey: category?.department.key || '',
    departmentName: category?.department.name || '',
    departmentSortOrder: String(category?.department.sortOrder ?? 0),
    aisleKey: category?.aisle.key || '',
    aisleName: category?.aisle.name || '',
    aisleSortOrder: String(category?.aisle.sortOrder ?? 0),
    shelfKey: category?.shelf.key || '',
    shelfName: category?.shelf.name || '',
    shelfSortOrder: String(category?.shelf.sortOrder ?? 0),
    sortOrder: String(category?.sortOrder ?? 0),
  }
}

function CategoryPlacementFields({ label, prefix, form, setForm }) {
  const keyField = `${prefix}Key`
  const nameField = `${prefix}Name`
  const sortField = `${prefix}SortOrder`
  return (
    <fieldset className="mih-market-category-placement">
      <legend>{label}</legend>
      <label className="qp-field"><span className="qp-field__label">Key</span><input className="qp-input mih-mono" value={form[keyField]} required maxLength={128} pattern="[a-z0-9][a-z0-9._-]{0,127}" onChange={(event) => setForm({ ...form, [keyField]: event.target.value })} /></label>
      <label className="qp-field"><span className="qp-field__label">名称</span><input className="qp-input" value={form[nameField]} required maxLength={160} onChange={(event) => setForm({ ...form, [nameField]: event.target.value })} /></label>
      <label className="qp-field"><span className="qp-field__label">排序</span><input className="qp-input" type="number" min="0" max="1000000" step="1" value={form[sortField]} required onChange={(event) => setForm({ ...form, [sortField]: event.target.value })} /></label>
    </fieldset>
  )
}

function CategoryEditorModal({ category, busy, error, onClose, onSave }) {
  const creating = !category
  const nameRef = useRef(null)
  const [form, setForm] = useState(() => categoryEditorForm(category))
  const submit = (event) => {
    event.preventDefault()
    const body = {
      ...(creating ? { key: form.key.trim() } : { expectedRevision: category.revision }),
      name: form.name.trim(),
      department: { key: form.departmentKey.trim(), name: form.departmentName.trim(), sortOrder: Number(form.departmentSortOrder) },
      aisle: { key: form.aisleKey.trim(), name: form.aisleName.trim(), sortOrder: Number(form.aisleSortOrder) },
      shelf: { key: form.shelfKey.trim(), name: form.shelfName.trim(), sortOrder: Number(form.shelfSortOrder) },
      sortOrder: Number(form.sortOrder),
    }
    onSave(body)
  }
  return (
    <Modal title={creating ? '新建商品分类' : '编辑商品分类'} description="分类定义商品陈列语义，不改变数据源目录中的来源平台分类。" size="large"
      busy={busy} initialFocusRef={nameRef} onClose={onClose}
      footer={<><button className="qp-button qp-button--ghost" type="button" disabled={busy} onClick={onClose}>返回分类列表</button><button className="qp-button qp-button--primary" type="submit" form="mih-market-category-form" disabled={busy}>保存分类</button></>}>
      <form className="mih-market-category-form" id="mih-market-category-form" onSubmit={submit}>
        {error ? <ErrorState error={error} /> : null}
        <div className="mih-market-edit__row">
          <label className="qp-field"><span className="qp-field__label">分类 Key</span><input className="qp-input mih-mono" value={form.key} disabled={!creating} required maxLength={128} pattern="[a-z0-9][a-z0-9._-]{0,127}" onChange={(event) => setForm({ ...form, key: event.target.value })} /><span className="qp-field__hint">创建后不可修改。</span></label>
          <label className="qp-field"><span className="qp-field__label">分类名称</span><input ref={nameRef} className="qp-input" value={form.name} required maxLength={160} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        </div>
        <div className="mih-market-category-placements">
          <CategoryPlacementFields label="部门 Department" prefix="department" form={form} setForm={setForm} />
          <CategoryPlacementFields label="通道 Aisle" prefix="aisle" form={form} setForm={setForm} />
          <CategoryPlacementFields label="货架 Shelf" prefix="shelf" form={form} setForm={setForm} />
        </div>
        <label className="qp-field"><span className="qp-field__label">分类排序</span><input className="qp-input" type="number" min="0" max="1000000" step="1" value={form.sortOrder} required onChange={(event) => setForm({ ...form, sortOrder: event.target.value })} /></label>
      </form>
    </Modal>
  )
}

export function VirtualSupermarketPage({ token, query, setQuery, onUnauthorized, notify }) {
  const mode = MODE_VALUES.has(query?.get('mode')) ? query.get('mode') : 'panorama'
  const searchQuery = query?.get('query') || ''
  const categoryId = query?.get('categoryId') || ''
  const department = query?.get('department') || ''
  const aisle = query?.get('aisle') || ''
  const shelf = query?.get('shelf') || ''
  const status = STATUS_OPTIONS.some((option) => option.value === query?.get('status')) ? query.get('status') : 'all'
  const sort = SORT_OPTIONS.some((option) => option.value === query?.get('sort')) ? query.get('sort') : 'newest'
  const requestedProductId = query?.get('product') || ''
  const [searchDraft, setSearchDraft] = useState(searchQuery)
  const [cursorStack, setCursorStack] = useState([null])
  const [cursorIndex, setCursorIndex] = useState(0)
  const [spatialProducts, setSpatialProducts] = useState([])
  const [spatialPageInfo, setSpatialPageInfo] = useState(null)
  const [spatialLoadingMore, setSpatialLoadingMore] = useState(false)
  const [spatialLoadError, setSpatialLoadError] = useState(null)
  const spatialGenerationRef = useRef(0)
  const [editProduct, setEditProduct] = useState(null)
  const [confirmProduct, setConfirmProduct] = useState(null)
  const [busyAction, setBusyAction] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false)
  const [categoryEditor, setCategoryEditor] = useState(null)
  const [categoryBusy, setCategoryBusy] = useState(false)
  const [categoryError, setCategoryError] = useState(null)
  const [inventoryNotice, setInventoryNotice] = useState('')
  const [inventoryRecovering, setInventoryRecovering] = useState(false)

  useEffect(() => setSearchDraft(searchQuery), [searchQuery])
  useEffect(() => {
    setCursorStack([null])
    setCursorIndex(0)
    spatialGenerationRef.current += 1
    setSpatialProducts([])
    setSpatialPageInfo(null)
    setSpatialLoadingMore(false)
    setSpatialLoadError(null)
    setInventoryNotice('')
    setInventoryRecovering(false)
  }, [aisle, categoryId, department, searchQuery, shelf, sort, status])

  const loadMetadata = useCallback(() => adminApi.dataProductVirtualSupermarketMetadata(token), [token])
  const metadata = useRemoteData(loadMetadata, onUnauthorized)
  const loadCategories = useCallback(() => adminApi.dataProductVirtualSupermarketCategories(token), [token])
  const categoriesState = useRemoteData(loadCategories, onUnauthorized)
  const viewKind = mode === 'catalog' ? 'catalog' : 'spatial'
  const viewKindRef = useRef(viewKind)
  viewKindRef.current = viewKind
  const cursor = viewKind === 'catalog' ? cursorStack[cursorIndex] : null
  const loadProducts = useCallback(() => adminApi.dataProductVirtualSupermarketProducts(token, {
    status,
    categoryId: categoryId || undefined,
    department: department || undefined,
    aisle: aisle || undefined,
    shelf: shelf || undefined,
    query: searchQuery || undefined,
    sort,
    pageSize: 96,
    cursor: cursor || undefined,
  }), [aisle, categoryId, cursor, department, searchQuery, shelf, sort, status, token, viewKind])
  const productsState = useRemoteData(loadProducts, onUnauthorized)
  const rawItems = Array.isArray(productsState.data?.items) ? productsState.data.items : []
  const pageProducts = useMemo(() => rawItems.map(normalizeProduct).filter((item) => item?.id), [rawItems])
  useEffect(() => {
    if (!productsState.data) return
    setInventoryRecovering(false)
    if (viewKindRef.current !== 'spatial') return
    const items = (productsState.data.items || []).map(normalizeProduct).filter((item) => item?.id)
    setSpatialProducts(items)
    setSpatialPageInfo({
      ...(productsState.data.pageInfo || {}),
      storefrontRevision: productsState.data.storefrontRevision,
      total: productsState.data.total,
    })
    setSpatialLoadError(null)
  }, [productsState.data])
  const products = inventoryRecovering ? [] : viewKind === 'spatial' ? spatialProducts : pageProducts
  const categories = useMemo(
    () => categoryItems(metadata.data, categoriesState.data),
    [categoriesState.data, metadata.data],
  )
  const departments = useMemo(() => groupDepartments(categories, products), [categories, products])
  const selectedCategory = categories.find((category) => category.id === categoryId) || null
  const selectedDepartment = departments.find((item) => item.key === department) || null
  const selectedPath = selectedCategory || (selectedDepartment ? {
    id: null,
    department: { key: selectedDepartment.key, name: selectedDepartment.name },
    aisle: { key: '', name: '全部通道' },
    shelf: { key: '', name: '全部货架' },
  } : null)
  const requestedListProduct = requestedProductId
    ? products.find((item) => item.id === requestedProductId) || null
    : null
  const fallbackSelected = requestedProductId ? requestedListProduct : products[0] || null
  const selectedId = requestedProductId || fallbackSelected?.id || ''
  const loadDetail = useCallback(async () => {
    if (!selectedId) return { requestedId: null, response: null }
    try {
      return { requestedId: selectedId, response: await adminApi.dataProductVirtualSupermarketProduct(token, selectedId) }
    } catch (error) {
      error.virtualSupermarketRequestedId = selectedId
      throw error
    }
  }, [selectedId, token])
  const detailState = useRemoteData(loadDetail, onUnauthorized)
  const detailMatchesSelection = detailState.data?.requestedId === selectedId
  const detailProduct = detailMatchesSelection
    ? normalizeProduct(detailState.data?.response?.item ?? detailState.data?.response)
    : null
  const evidenceError = selectedId && detailState.error?.virtualSupermarketRequestedId === selectedId
    ? detailState.error
    : null
  const selected = inventoryRecovering || evidenceError
    ? null
    : detailProduct || (fallbackSelected?.id === selectedId ? fallbackSelected : null)
  const evidenceLoading = Boolean(selectedId && (inventoryRecovering || (!detailMatchesSelection && !evidenceError)))
  const pageInfo = inventoryRecovering ? {} : {
    ...(productsState.data?.pageInfo ?? {}),
    storefrontRevision: productsState.data?.storefrontRevision,
  }

  const resetInventoryFromFirstPage = useCallback((message = '数据已变化，已从第一页刷新') => {
    const needsCatalogNavigation = viewKind === 'catalog' && cursorIndex > 0
    spatialGenerationRef.current += 1
    setCursorStack([null])
    setCursorIndex(0)
    setSpatialProducts([])
    setSpatialPageInfo(null)
    setSpatialLoadingMore(false)
    setSpatialLoadError(null)
    setInventoryRecovering(true)
    setInventoryNotice(message)
    detailState.refresh()
    if (!needsCatalogNavigation) productsState.refresh()
  }, [cursorIndex, detailState.refresh, productsState.refresh, viewKind])

  useEffect(() => {
    if (!isInventoryConflict(productsState.error) || inventoryRecovering) return
    resetInventoryFromFirstPage()
  }, [inventoryRecovering, productsState.error, resetInventoryFromFirstPage])

  useEffect(() => {
    if (inventoryRecovering && productsState.error && !isInventoryConflict(productsState.error)) {
      setInventoryRecovering(false)
    }
  }, [inventoryRecovering, productsState.error])

  const selectCategory = (category) => setQuery({
    categoryId: category.id,
    department: null,
    aisle: null,
    shelf: null,
    product: null,
  })
  const resetCategory = () => setQuery({ categoryId: null, department: null, aisle: null, shelf: null, product: null })
  const selectDepartment = (department) => setQuery({
    categoryId: null,
    department: department.key,
    aisle: null,
    shelf: null,
    product: null,
  })
  const selectProduct = (id) => setQuery({ product: id })
  const enterShelf = () => setQuery({ mode: 'browse', categoryId: selected?.categoryId || categoryId || null })

  const refreshAll = ({ storefrontChanged = false } = {}) => {
    metadata.refresh()
    categoriesState.refresh()
    detailState.refresh()
    if (storefrontChanged) resetInventoryFromFirstPage()
    else productsState.refresh()
  }
  const mutate = async (label, action) => {
    setBusyAction(label)
    setActionError(null)
    try {
      await action()
      notify?.(label, 'success')
      setEditProduct(null)
      setConfirmProduct(null)
      refreshAll({ storefrontChanged: true })
    } catch (error) {
      if (error?.status === 401) onUnauthorized?.(error)
      setActionError(error)
    } finally {
      setBusyAction(null)
    }
  }
  const saveEdit = (body) => mutate('商品展示已保存', () => (
    adminApi.updateDataProductVirtualSupermarketProduct(token, editProduct.id, body)
  ))
  const confirmListing = () => {
    if (!confirmProduct) return
    const willPublish = confirmProduct.status !== 'on_shelf'
    const action = willPublish
      ? adminApi.publishDataProductVirtualSupermarketProduct
      : adminApi.unpublishDataProductVirtualSupermarketProduct
    mutate(willPublish ? '商品已上架' : '商品已下架', () => action(token, confirmProduct.id, {
      expectedRevision: confirmProduct.revision,
      reason: willPublish ? '管理台手动上架' : '管理台手动下架',
    }))
  }
  const submitSearch = (event) => {
    event.preventDefault()
    setQuery({ query: searchDraft.trim() || null, product: null })
  }
  const resetView = () => {
    setSearchDraft('')
    setQuery({ query: null, categoryId: null, department: null, aisle: null, shelf: null, status: null, sort: null, product: null })
  }
  const saveCategory = async (body) => {
    if (!categoryEditor) return
    setCategoryBusy(true)
    setCategoryError(null)
    try {
      if (categoryEditor.mode === 'create') {
        await adminApi.createDataProductVirtualSupermarketCategory(token, body)
        notify?.('商品分类已创建', 'success')
      } else {
        await adminApi.updateDataProductVirtualSupermarketCategory(token, categoryEditor.category.id, body)
        notify?.('商品分类已更新', 'success')
      }
      setCategoryEditor(null)
      metadata.refresh()
      categoriesState.refresh()
      detailState.refresh()
      resetInventoryFromFirstPage()
    } catch (error) {
      if (error?.status === 401) onUnauthorized?.(error)
      setCategoryError(error)
    } finally {
      setCategoryBusy(false)
    }
  }
  const retryProducts = () => {
    if (viewKind === 'catalog' && cursorIndex > 0) {
      setCursorStack([null])
      setCursorIndex(0)
    } else {
      productsState.refresh()
    }
  }
  const loadMoreSpatial = async () => {
    const nextCursor = spatialPageInfo?.nextCursor
    if (!nextCursor || spatialLoadingMore) return
    const generation = spatialGenerationRef.current
    setSpatialLoadingMore(true)
    setSpatialLoadError(null)
    try {
      const data = await adminApi.dataProductVirtualSupermarketProducts(token, {
        status,
        categoryId: categoryId || undefined,
        department: department || undefined,
        aisle: aisle || undefined,
        shelf: shelf || undefined,
        query: searchQuery || undefined,
        sort,
        pageSize: 96,
        cursor: nextCursor,
      })
      if (generation !== spatialGenerationRef.current) return
      const items = (data?.items || []).map(normalizeProduct).filter((item) => item?.id)
      setSpatialProducts((current) => {
        const unique = new Map(current.map((item) => [item.id, item]))
        for (const item of items) unique.set(item.id, item)
        return [...unique.values()]
      })
      setSpatialPageInfo({
        ...(data?.pageInfo || {}),
        storefrontRevision: data?.storefrontRevision,
        total: data?.total,
      })
    } catch (error) {
      if (generation !== spatialGenerationRef.current) return
      if (error?.status === 401) onUnauthorized?.(error)
      if (isInventoryConflict(error)) resetInventoryFromFirstPage()
      else setSpatialLoadError(error)
    } finally {
      if (generation === spatialGenerationRef.current) setSpatialLoadingMore(false)
    }
  }

  const commonActions = {
    select: selectProduct,
    selectCategory,
    selectDepartment,
    resetCategory,
    evidence: {
      loading: evidenceLoading,
      error: evidenceError,
      onRetry: detailState.refresh,
      onSelect: selectProduct,
      onEdit: (product) => { setActionError(null); setEditProduct(product) },
      onToggleListing: (product) => { setActionError(null); setConfirmProduct(product) },
      onEnterShelf: enterShelf,
    },
  }
  const spatialPagination = {
    loadedCount: spatialProducts.length,
    pageInfo: spatialPageInfo,
    loading: spatialLoadingMore,
    error: spatialLoadError,
    onLoadMore: loadMoreSpatial,
  }

  if ((metadata.loading || categoriesState.loading || productsState.loading) && !productsState.data) {
    return <LoadingState label="正在打开虚拟超市" />
  }
  if (metadata.error && !metadata.data) return <ErrorState error={metadata.error} onRetry={metadata.refresh} />
  if (categoriesState.error && !categoriesState.data) return <ErrorState error={categoriesState.error} onRetry={categoriesState.refresh} />
  if (productsState.error && !productsState.data && !isInventoryConflict(productsState.error)) return <ErrorState error={productsState.error} onRetry={productsState.refresh} />

  return (
    <section className="mih-product-page mih-market-page">
      <h1 className="mih-sr-only">虚拟超市</h1>
      <header className="mih-market-toolbar">
        <form className="mih-product-search" role="search" onSubmit={submitSearch}>
          <MagnifyingGlass size={18} aria-hidden="true" />
          <input aria-label="搜索虚拟超市商品" value={searchDraft} placeholder="搜索商品标题或已核验规格" onChange={(event) => setSearchDraft(event.target.value)} />
          <button type="submit">搜索</button>
        </form>
        <div className="mih-command-segmented mih-market-modes" aria-label="虚拟超市视图">
          {MODE_OPTIONS.map(({ value, label, icon: Icon }) => (
            <button key={value} type="button" aria-pressed={mode === value} onClick={() => setQuery({ mode: value })}>
              <Icon size={16} aria-hidden="true" />{label}
            </button>
          ))}
        </div>
        <div className="mih-market-toolbar__actions">
          <button className="qp-button qp-button--ghost" type="button" onClick={() => { setCategoryError(null); setCategoryEditor(null); setCategoryManagerOpen(true) }}><Package size={16} aria-hidden="true" />管理分类</button>
          <button className="qp-button qp-button--ghost" type="button" onClick={resetView}><ArrowClockwise size={16} aria-hidden="true" />重置视角</button>
          <button className="qp-button qp-button--outline" type="button" disabled={!selected} onClick={enterShelf}><Storefront size={16} aria-hidden="true" />进入货架</button>
        </div>
      </header>
      {metadata.data?.demoMode ? (
        <div className="mih-market-mode-note"><CheckCircle size={16} weight="fill" aria-hidden="true" />当前为本地演示发布面；上架状态与源采集证据仍保持分离。</div>
      ) : null}
      {inventoryNotice ? <div className="mih-market-inventory-notice" role="status"><ArrowClockwise size={16} aria-hidden="true" />{inventoryNotice}</div> : null}
      {productsState.error && !isInventoryConflict(productsState.error) ? <ErrorState error={productsState.error} onRetry={retryProducts} /> : null}
      {actionError && !editProduct && !confirmProduct ? <ErrorState error={actionError} /> : null}
      {mode === 'panorama' ? <PanoramaView departments={departments} categories={categories} products={products}
        selected={selected} selectedCategory={selectedPath} actions={commonActions} spatialPagination={spatialPagination} /> : null}
      {mode === 'browse' ? <BrowseView departments={departments} products={products}
        selected={selected} selectedCategory={selectedPath} actions={commonActions} spatialPagination={spatialPagination} /> : null}
      {mode === 'catalog' ? <CatalogView products={products} selected={selected} categories={categories}
        status={status} sort={sort} pageInfo={pageInfo} loading={productsState.loading} actions={{
          categoryId,
          select: selectProduct,
          edit: (product) => { setActionError(null); setEditProduct(product) },
          toggle: (product) => { setActionError(null); setConfirmProduct(product) },
          setStatus: (value) => setQuery({ status: value === 'all' ? null : value, product: null }),
          setCategoryId: (value) => setQuery({ categoryId: value === 'all' ? null : value, department: null, aisle: null, shelf: null, product: null }),
          setSort: (value) => setQuery({ sort: value === 'newest' ? null : value, product: null }),
          canPrevious: cursorIndex > 0,
          pageNumber: cursorIndex + 1,
          previousPage: () => setCursorIndex((value) => Math.max(0, value - 1)),
          nextPage: (nextCursor) => {
            setCursorStack((current) => [...current.slice(0, cursorIndex + 1), nextCursor])
            setCursorIndex((value) => value + 1)
          },
        }} /> : null}
      {categoryManagerOpen && !categoryEditor ? <CategoryManagerModal categories={categories} loading={categoriesState.loading}
        error={categoriesState.error} onClose={() => setCategoryManagerOpen(false)}
        onCreate={() => { setCategoryError(null); setCategoryEditor({ mode: 'create', category: null }) }}
        onEdit={(category) => { setCategoryError(null); setCategoryEditor({ mode: 'edit', category }) }} /> : null}
      {categoryEditor ? <CategoryEditorModal key={`${categoryEditor.mode}-${categoryEditor.category?.id || 'new'}`}
        category={categoryEditor.category} busy={categoryBusy} error={categoryError}
        onClose={() => { if (!categoryBusy) { setCategoryError(null); setCategoryEditor(null) } }} onSave={saveCategory} /> : null}
      {editProduct ? <EditProductModal key={editProduct.id} product={editProduct} categories={categories} busy={Boolean(busyAction)}
        error={actionError} onClose={() => { if (!busyAction) { setEditProduct(null); setActionError(null) } }} onSave={saveEdit} /> : null}
      {confirmProduct ? (
        <ConfirmDialog
          title={confirmProduct.status === 'on_shelf' ? '确认下架商品？' : '确认上架商品？'}
          description={confirmProduct.title}
          confirmLabel={confirmProduct.status === 'on_shelf' ? '确认下架' : '确认上架'}
          tone={confirmProduct.status === 'on_shelf' ? 'danger' : 'primary'}
          busy={Boolean(busyAction)}
          onCancel={() => { if (!busyAction) { setConfirmProduct(null); setActionError(null) } }}
          onConfirm={confirmListing}
        >
          {actionError ? <ErrorState error={actionError} /> : (
            <p className="mih-market-confirm-copy">
              {confirmProduct.status === 'on_shelf'
                ? '下架后商品会从虚拟超市 Public API 与货架展示中消失，但不会删除 canonical 采集记录或证据。'
                : '上架后商品会进入虚拟超市发布面；请确认展示字段、分类与货架位置已经核验。'}
            </p>
          )}
        </ConfirmDialog>
      ) : null}
    </section>
  )
}
