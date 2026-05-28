<template>
  <div ref="host" class="hdo-topology-scene" tabindex="0" aria-label="HDO 3D topology graph">
    <div v-if="items.length === 0" class="hdo-topology-empty">暂无拓扑数据。</div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as THREE from 'three';

type TopologyAction = 'mesh' | 'node' | 'device' | 'service' | 'profile';

interface SceneTopologyItem {
  key: string;
  id: string;
  action: TopologyAction;
  label: string;
  shortLabel: string;
  caption: string;
  kindLabel: string;
  statusLabel: string;
  color: string;
  glyph: string;
  x: number;
  y: number;
  parentKey: string | null;
  meshGroupId: string | null;
}

interface SceneTopologyBand {
  key: string;
  label: string;
  caption: string;
  y: number;
  height: number;
}

const props = defineProps<{
  items: SceneTopologyItem[];
  meshBands: SceneTopologyBand[];
  selectedKey: string | null;
}>();

const emit = defineEmits<{
  select: [key: string];
}>();

const host = ref<HTMLDivElement | null>(null);

let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let root: THREE.Group | null = null;
let animationId = 0;
let resizeObserver: ResizeObserver | null = null;
let raycaster: THREE.Raycaster | null = null;
let pointer = new THREE.Vector2();
let pickables: THREE.Object3D[] = [];
let yaw = 0;
let pitch = -0.08;
let distance = 1500;
let dragStart: { x: number; y: number; yaw: number; pitch: number } | null = null;
let dragMoved = false;
let meshCountForCamera = 1;

onMounted(() => {
  initScene();
  rebuildScene();
  resizeScene();
  animate();
});

onBeforeUnmount(() => {
  if (animationId) cancelAnimationFrame(animationId);
  resizeObserver?.disconnect();
  if (renderer) {
    renderer.dispose();
    renderer.domElement.remove();
  }
  disposeObject(root);
  scene = null;
  camera = null;
  renderer = null;
  root = null;
  pickables = [];
});

watch(
  () => [props.items, props.meshBands, props.selectedKey] as const,
  () => rebuildScene(),
  { deep: true }
);

function initScene(): void {
  if (!host.value) return;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf8fafc);

  camera = new THREE.PerspectiveCamera(42, 1, 1, 4000);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.value.appendChild(renderer.domElement);

  root = new THREE.Group();
  scene.add(root);
  applyCamera();
  scene.add(new THREE.AmbientLight(0xffffff, 0.72));

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
  keyLight.position.set(240, 380, 460);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xb6d5ff, 0.55);
  fillLight.position.set(-420, 220, -280);
  scene.add(fillLight);

  raycaster = new THREE.Raycaster();
  resizeObserver = new ResizeObserver(resizeScene);
  resizeObserver.observe(host.value);

  host.value.addEventListener('pointerdown', onPointerDown);
  host.value.addEventListener('pointermove', onPointerMove);
  host.value.addEventListener('pointerup', onPointerUp);
  host.value.addEventListener('pointercancel', onPointerCancel);
  host.value.addEventListener('wheel', onWheel, { passive: false });
}

function rebuildScene(): void {
  if (!root) return;
  disposeObject(root);
  root.clear();
  pickables = [];

  const bands = props.meshBands.length ? props.meshBands : fallbackBands();
  meshCountForCamera = bands.length;
  applyCamera();
  const centers = meshCenters(bands.length);
  const bandByKey = new Map(bands.map((band, index) => [band.key, { band, index }]));
  const itemByKey = new Map(props.items.map((item) => [item.key, item]));
  const pointByKey = new Map<string, THREE.Vector3>();

  bands.forEach((band, index) => {
    addMeshDeck(root as THREE.Group, band, centers[index]);
  });

  props.items.forEach((item) => {
    const bandKey = item.action === 'mesh'
      ? item.key
      : (item.meshGroupId ? `mesh:${item.meshGroupId}` : bands[0]?.key);
    const bandRow = bandByKey.get(bandKey) ?? { band: bands[0], index: 0 };
    const point = topologyPoint(item, bandRow.band, centers[bandRow.index]);
    pointByKey.set(item.key, point);
  });

  props.items.forEach((item) => {
    if (!item.parentKey || !itemByKey.has(item.parentKey)) return;
    const from = pointByKey.get(item.parentKey);
    const to = pointByKey.get(item.key);
    if (!from || !to) return;
    const selected = item.key === props.selectedKey || item.parentKey === props.selectedKey;
    addEdge(root as THREE.Group, from, to, selected);
  });

  props.items.forEach((item) => {
    const point = pointByKey.get(item.key);
    if (!point) return;
    addNode(root as THREE.Group, item, point, item.key === props.selectedKey);
  });

  const grid = new THREE.GridHelper(1320, 18, 0xd7dee8, 0xe7ecf3);
  grid.position.y = -90;
  root.add(grid);
}

function fallbackBands(): SceneTopologyBand[] {
  return [{ key: 'mesh:fallback', label: 'HDO', caption: '', y: 24, height: 220 }];
}

function meshCenters(count: number): THREE.Vector3[] {
  const sceneWidth = host.value?.clientWidth ?? 0;
  const columns = sceneWidth < 640
    ? 1
    : (count <= 5 ? Math.max(1, count) : 3);
  const rows = Math.ceil(count / columns);
  const xGap = columns >= 4 ? 190 : 520;
  const zGap = 300;
  return Array.from({ length: count }, (_row, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return new THREE.Vector3(
      (column - (columns - 1) / 2) * xGap,
      0,
      (row - (rows - 1) / 2) * zGap
    );
  });
}

function topologyPoint(
  item: SceneTopologyItem,
  band: SceneTopologyBand,
  center: THREE.Vector3
): THREE.Vector3 {
  const laneCenter = band.y + band.height / 2;
  return new THREE.Vector3(
    center.x + (item.x - 480) * 0.5,
    verticalFor(item.action),
    center.z + (item.y - laneCenter) * 0.78
  );
}

function verticalFor(action: TopologyAction): number {
  if (action === 'node') return 72;
  if (action === 'mesh') return 42;
  if (action === 'profile') return 28;
  if (action === 'service') return -38;
  return 6;
}

function addMeshDeck(group: THREE.Group, band: SceneTopologyBand, center: THREE.Vector3): void {
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(500, 210),
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.88,
      metalness: 0,
      transparent: true,
      opacity: 0.82
    })
  );
  plane.rotation.x = -Math.PI / 2;
  plane.position.set(center.x, -82, center.z);
  group.add(plane);

  const border = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(center.x - 250, -80, center.z - 105),
      new THREE.Vector3(center.x + 250, -80, center.z - 105),
      new THREE.Vector3(center.x + 250, -80, center.z + 105),
      new THREE.Vector3(center.x - 250, -80, center.z + 105)
    ]),
    new THREE.LineBasicMaterial({ color: 0xd5dde8, transparent: true, opacity: 0.85 })
  );
  group.add(border);

  const label = createLabelSprite(
    band.label,
    band.caption,
    { width: 420, height: 100, fontSize: 30, captionSize: 18, background: 'rgba(255,255,255,0.92)' }
  );
  label.position.set(center.x - 60, -34, center.z - 132);
  label.scale.set(178, 42, 1);
  group.add(label);
}

function addEdge(group: THREE.Group, from: THREE.Vector3, to: THREE.Vector3, selected: boolean): void {
  const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
  const material = new THREE.LineBasicMaterial({
    color: selected ? 0x1976d2 : 0xa9b7c9,
    transparent: true,
    opacity: selected ? 0.95 : 0.62
  });
  group.add(new THREE.Line(geometry, material));
}

function addNode(group: THREE.Group, item: SceneTopologyItem, point: THREE.Vector3, selected: boolean): void {
  const radius = radiusFor(item.action);
  const node = new THREE.Group();
  node.position.copy(point);

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 32, 20),
    new THREE.MeshStandardMaterial({
      color: colorFor(item.color),
      roughness: 0.52,
      metalness: 0.12
    })
  );
  sphere.userData.key = item.key;
  sphere.userData.label = topologyTitle(item);
  pickables.push(sphere);
  node.add(sphere);

  const status = new THREE.Mesh(
    new THREE.SphereGeometry(Math.max(5, radius * 0.28), 18, 12),
    new THREE.MeshStandardMaterial({ color: colorFor(item.color), roughness: 0.45 })
  );
  status.position.set(radius * 0.82, radius * 0.78, radius * 0.28);
  node.add(status);

  if (selected) {
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 1.22, 32, 16),
      new THREE.MeshBasicMaterial({
        color: 0x1976d2,
        transparent: true,
        opacity: 0.2,
        wireframe: true
      })
    );
    node.add(halo);
  }

  const glyph = createGlyphSprite(item.glyph);
  glyph.position.set(0, radius + 7, 0);
  glyph.scale.set(36, 24, 1);
  node.add(glyph);

  const label = createLabelSprite(item.shortLabel, item.caption, {
    width: 300,
    height: 94,
    fontSize: 24,
    captionSize: 18,
    background: selected ? 'rgba(240,247,255,0.96)' : 'rgba(255,255,255,0.84)'
  });
  label.position.set(0, -radius - 28, 0);
  label.scale.set(106, 34, 1);
  node.add(label);

  group.add(node);
}

function radiusFor(action: TopologyAction): number {
  if (action === 'mesh') return 18;
  if (action === 'node') return 17;
  if (action === 'service') return 13;
  if (action === 'profile') return 13;
  return 15;
}

function colorFor(color: string): number {
  if (color === 'positive') return 0x1fb65b;
  if (color === 'warning') return 0xf2b832;
  if (color === 'negative') return 0xd92d20;
  if (color === 'primary') return 0x1976d2;
  return 0x9aa4b2;
}

function createGlyphSprite(glyph: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 80;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.font = '700 38px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(glyph.slice(0, 2), 64, 42);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
}

function createLabelSprite(
  title: string,
  caption: string,
  options: { width: number; height: number; fontSize: number; captionSize: number; background: string }
): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = options.width;
  canvas.height = options.height;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  roundedRect(ctx, 8, 8, canvas.width - 16, canvas.height - 16, 14, options.background);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#101828';
  ctx.font = `700 ${options.fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.fillText(truncate(title, 24), canvas.width / 2, canvas.height * 0.42);
  if (caption) {
    ctx.fillStyle = '#667085';
    ctx.font = `500 ${options.captionSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.fillText(truncate(caption, 28), canvas.width / 2, canvas.height * 0.68);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fill: string
): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

function topologyTitle(item: SceneTopologyItem): string {
  return `${item.label}\n${item.kindLabel}\n${item.statusLabel}`;
}

function onPointerDown(event: PointerEvent): void {
  if (!host.value) return;
  dragStart = { x: event.clientX, y: event.clientY, yaw, pitch };
  dragMoved = false;
  host.value.setPointerCapture(event.pointerId);
  host.value.classList.add('is-dragging');
}

function onPointerMove(event: PointerEvent): void {
  if (!dragStart) return;
  const dx = event.clientX - dragStart.x;
  const dy = event.clientY - dragStart.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) dragMoved = true;
  yaw = dragStart.yaw + dx * 0.006;
  pitch = clamp(dragStart.pitch + dy * 0.004, -0.72, 0.2);
  applyCamera();
}

function onPointerUp(event: PointerEvent): void {
  if (!host.value || !dragStart) return;
  host.value.releasePointerCapture(event.pointerId);
  host.value.classList.remove('is-dragging');
  const shouldPick = !dragMoved;
  dragStart = null;
  if (shouldPick) pickNode(event);
}

function onPointerCancel(event: PointerEvent): void {
  if (!host.value) return;
  host.value.releasePointerCapture(event.pointerId);
  host.value.classList.remove('is-dragging');
  dragStart = null;
}

function onWheel(event: WheelEvent): void {
  event.preventDefault();
  distance = clamp(distance + event.deltaY * 0.9, 820, 2600);
  applyCamera();
}

function pickNode(event: PointerEvent): void {
  if (!host.value || !camera || !raycaster) return;
  const rect = host.value.getBoundingClientRect();
  pointer = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(pickables, false)[0];
  const key = hit?.object.userData.key;
  if (typeof key === 'string') emit('select', key);
}

function applyCamera(): void {
  if (!camera || !root) return;
  camera.position.set(0, 175, distance);
  camera.lookAt(0, 0, 0);
  root.position.set(meshCountForCamera >= 4 ? -140 : 0, 110, 0);
  root.rotation.set(pitch, yaw, 0);
}

function resizeScene(): void {
  if (!host.value || !renderer || !camera) return;
  const rect = host.value.getBoundingClientRect();
  const width = Math.max(320, rect.width);
  const height = Math.max(420, rect.height);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function animate(): void {
  animationId = requestAnimationFrame(animate);
  if (renderer && scene && camera) renderer.render(scene, camera);
}

function disposeObject(object: THREE.Object3D | null): void {
  if (!object) return;
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    if (geometry) geometry.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) {
      material.forEach(disposeMaterial);
    } else if (material) {
      disposeMaterial(material);
    }
  });
}

function disposeMaterial(material: THREE.Material): void {
  const maybeTexture = material as THREE.Material & { map?: THREE.Texture };
  maybeTexture.map?.dispose();
  material.dispose();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
</script>

<style scoped>
.hdo-topology-scene {
  position: relative;
  width: 100%;
  height: clamp(440px, 58vh, 760px);
  min-height: 420px;
  border: 1px solid #e4e7ec;
  border-radius: 8px;
  overflow: hidden;
  background: #f8fafc;
  cursor: grab;
  touch-action: none;
}

.hdo-topology-scene.is-dragging {
  cursor: grabbing;
}

.hdo-topology-scene canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.hdo-topology-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #667085;
  font-size: 13px;
  pointer-events: none;
}
</style>
