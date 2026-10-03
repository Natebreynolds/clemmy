"use client";

import { useEffect, useRef } from "react";
import type { MotionValue } from "framer-motion";
import type * as Three from "three";

type JourneyWorldProps = {
  progress: MotionValue<number>;
  still: boolean;
  detail?: number;
};

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

/** One physical world. Scroll changes the camera, never the scene. */
export function JourneyWorld({ progress, still, detail = 0 }: JourneyWorldProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const optionsRef = useRef({ still, detail });
  const requestRenderRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    optionsRef.current = { still, detail };
    requestRenderRef.current?.();
  }, [still, detail]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    let disposed = false;
    let frame = 0;
    let width = 0;
    let height = 0;
    let revision = 0;
    let renderer: Three.WebGLRenderer | undefined;
    let scene: Three.Scene | undefined;
    let renderWorld = () => {};
    const geometries = new Set<Three.BufferGeometry>();
    const materials = new Set<Three.Material>();
    const textures = new Set<Three.Texture>();
    const shadowMaps = new Set<Three.LightShadow>();
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

    const requestRender = () => {
      if (disposed || frame || document.hidden) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (disposed || document.hidden) return;
        // Sticky layout can change during deep-link hydration without a fresh
        // IntersectionObserver result. Current geometry is the rendering gate.
        const bounds = host.getBoundingClientRect();
        const inView = bounds.width > 0 && bounds.height > 0
          && bounds.bottom > -80 && bounds.top < window.innerHeight + 80
          && bounds.right > 0 && bounds.left < window.innerWidth;
        if (inView) renderWorld();
      });
    };
    const updateProgress = () => {
      const value = clamp(progress.get());
      host.dataset.cameraProgress = value.toFixed(4);
      canvas.dataset.cameraProgress = value.toFixed(4);
      requestRender();
    };
    const onContextLost = (event: Event) => {
      event.preventDefault();
      canvas.style.opacity = "0";
      canvas.dataset.worldReady = "false";
      host.dataset.worldState = "fallback";
    };
    const onContextRestored = () => requestRender();
    const observer = new ResizeObserver(requestRender);
    // The observer wakes the renderer; a cached entry never vetoes a frame.
    const visibilityObserver = new IntersectionObserver(requestRender, { rootMargin: "80px" });

    observer.observe(host);
    visibilityObserver.observe(host);
    const unsubscribe = progress.on("change", updateProgress);
    motionQuery.addEventListener("change", requestRender);
    document.addEventListener("visibilitychange", requestRender);
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);
    requestRenderRef.current = requestRender;

    void import("three").then((THREE) => {
      if (disposed) return;

      try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "low-power" });
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.12;
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;

        scene = new THREE.Scene();
        scene.background = new THREE.Color("#26150f");
        scene.fog = new THREE.FogExp2("#26150f", 0.009);
        const camera = new THREE.PerspectiveCamera(39, 1, 0.1, 310);

        const geometry = <T extends Three.BufferGeometry>(value: T): T => {
          geometries.add(value);
          return value;
        };
        const material = <T extends Three.Material>(value: T): T => {
          materials.add(value);
          return value;
        };

        // A repeatable plaster microtexture; the architecture remains real geometry.
        const grainCanvas = document.createElement("canvas");
        grainCanvas.width = 256;
        grainCanvas.height = 256;
        const grainContext = grainCanvas.getContext("2d");
        if (grainContext) {
          const data = grainContext.createImageData(256, 256);
          let seed = 41;
          for (let pixel = 0; pixel < data.data.length; pixel += 4) {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            const value = 118 + (seed % 25);
            data.data[pixel] = value;
            data.data[pixel + 1] = value;
            data.data[pixel + 2] = value;
            data.data[pixel + 3] = 255;
          }
          grainContext.putImageData(data, 0, 0);
        }
        const grain = new THREE.CanvasTexture(grainCanvas);
        grain.wrapS = grain.wrapT = THREE.RepeatWrapping;
        grain.repeat.set(4, 4);
        textures.add(grain);
        const floorGrain = grain.clone();
        floorGrain.repeat.set(50, 75);
        floorGrain.needsUpdate = true;
        textures.add(floorGrain);

        const clay = material(new THREE.MeshStandardMaterial({ color: "#9a4c32", roughness: 0.88, bumpMap: grain, bumpScale: 0.035 }));
        const terracotta = material(new THREE.MeshStandardMaterial({ color: "#bf6948", roughness: 0.72, bumpMap: grain, bumpScale: 0.025 }));
        const cream = material(new THREE.MeshStandardMaterial({ color: "#decfb1", roughness: 0.75, bumpMap: grain, bumpScale: 0.018 }));
        const ink = material(new THREE.MeshStandardMaterial({ color: "#3d2a22", roughness: 0.55, metalness: 0.08, bumpMap: grain, bumpScale: 0.02 }));
        const copper = material(new THREE.MeshStandardMaterial({ color: "#bf7546", roughness: 0.35, metalness: 0.62 }));
        const pathMaterial = material(new THREE.MeshStandardMaterial({ color: "#f3bc76", emissive: "#f6a64f", emissiveIntensity: 3.2, roughness: 0.4, metalness: 0.08 }));
        const pathBedMaterial = material(new THREE.MeshStandardMaterial({ color: "#8c492a", roughness: 0.58, metalness: 0.5 }));
        const paperMaterial = material(new THREE.MeshStandardMaterial({ color: "#f0dfb9", roughness: 0.95 }));

        const mesh = (shape: Three.BufferGeometry, surface: Three.Material, x = 0, y = 0, z = 0, parent: Three.Object3D = scene!) => {
          const object = new THREE.Mesh(shape, surface);
          object.position.set(x, y, z);
          object.castShadow = true;
          object.receiveShadow = true;
          parent.add(object);
          return object;
        };

        const labelPainters: Array<() => void> = [];
        const placard = (label: string, x: number, y: number, z: number, angle = 0, parent: Three.Object3D = scene!) => {
          const labelCanvas = document.createElement("canvas");
          labelCanvas.width = 896;
          labelCanvas.height = 208;
          const labelContext = labelCanvas.getContext("2d");
          const texture = new THREE.CanvasTexture(labelCanvas);
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.anisotropy = Math.min(8, renderer!.capabilities.getMaxAnisotropy());
          textures.add(texture);
          const paint = () => {
            if (!labelContext) return;
            labelContext.fillStyle = "#ead7b5";
            labelContext.fillRect(0, 0, 896, 208);
            labelContext.fillStyle = "#34271f";
            labelContext.textAlign = "center";
            labelContext.textBaseline = "middle";
            labelContext.font = '600 88px "Plus Jakarta Sans Variable", sans-serif';
            labelContext.fillText(label, 448, 108, 800);
            texture.needsUpdate = true;
          };
          paint();
          labelPainters.push(paint);
          const board = new THREE.Group();
          board.position.set(x, y, z);
          board.rotation.set(-0.42, angle, 0);
          parent.add(board);
          mesh(geometry(new THREE.BoxGeometry(3.55, 0.82, 0.085)), paperMaterial, 0, 0, 0, board);
          const lettering = mesh(
            geometry(new THREE.PlaneGeometry(3.52, 0.79)),
            material(new THREE.MeshStandardMaterial({ map: texture, roughness: 0.9, metalness: 0 })),
            0, 0, 0.045, board,
          );
          lettering.castShadow = false;
          return board;
        };

        const roundedSlab = (w: number, d: number, h: number, radius = 0.3) => {
          const r = Math.min(radius, w / 2, d / 2);
          const shape = new THREE.Shape();
          shape.moveTo(-w / 2 + r, -d / 2);
          shape.lineTo(w / 2 - r, -d / 2);
          shape.quadraticCurveTo(w / 2, -d / 2, w / 2, -d / 2 + r);
          shape.lineTo(w / 2, d / 2 - r);
          shape.quadraticCurveTo(w / 2, d / 2, w / 2 - r, d / 2);
          shape.lineTo(-w / 2 + r, d / 2);
          shape.quadraticCurveTo(-w / 2, d / 2, -w / 2, d / 2 - r);
          shape.lineTo(-w / 2, -d / 2 + r);
          shape.quadraticCurveTo(-w / 2, -d / 2, -w / 2 + r, -d / 2);
          const result = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 0.035, bevelThickness: 0.035, curveSegments: 10 });
          result.rotateX(-Math.PI / 2);
          return geometry(result);
        };

        const makeArch = (w: number, h: number, depth: number, surface: Three.Material, x: number, z: number, y = 0) => {
          const wall = w * 0.18;
          const outerRadius = w / 2;
          const outer = new THREE.Shape();
          outer.moveTo(-w / 2, 0);
          outer.lineTo(-w / 2, h - outerRadius);
          outer.absarc(0, h - outerRadius, outerRadius, Math.PI, 0, true);
          outer.lineTo(w / 2, 0);
          outer.lineTo(w / 2 - wall, 0);
          outer.lineTo(w / 2 - wall, h - outerRadius);
          outer.absarc(0, h - outerRadius, outerRadius - wall, 0, Math.PI, false);
          outer.lineTo(-w / 2 + wall, 0);
          outer.closePath();
          const shape = geometry(new THREE.ExtrudeGeometry(outer, { depth, bevelEnabled: true, bevelSegments: 2, bevelSize: 0.06, bevelThickness: 0.06, curveSegments: 24 }));
          return mesh(shape, surface, x, y, z);
        };

        const floor = mesh(geometry(new THREE.PlaneGeometry(260, 430)), material(new THREE.MeshStandardMaterial({ color: "#743b29", roughness: 0.95, bumpMap: floorGrain, bumpScale: 0.045 })), 0, -0.08, -85);
        floor.rotation.x = -Math.PI / 2;
        floor.castShadow = false;

        scene.add(new THREE.HemisphereLight("#fbe3bd", "#372017", 2.0));
        const key = new THREE.DirectionalLight("#ffddb0", 4.1);
        key.castShadow = true;
        key.shadow.mapSize.set(2048, 2048);
        key.shadow.camera.left = -25;
        key.shadow.camera.right = 25;
        key.shadow.camera.top = 28;
        key.shadow.camera.bottom = -28;
        key.shadow.camera.near = 1;
        key.shadow.camera.far = 95;
        key.shadow.normalBias = 0.045;
        key.shadow.bias = -0.0002;
        key.shadow.radius = 3;
        shadowMaps.add(key.shadow);
        scene.add(key, key.target);
        const rim = new THREE.DirectionalLight("#ed8650", 1.7);
        scene.add(rim, rim.target);

        // Repeated architectural bays establish one continuous room at full scale.
        for (const z of [5, -27, -57, -85, -115, -145]) {
          makeArch(15, 16, 2.2, clay, 28, z - 4).rotation.y = -Math.PI / 2;
          mesh(roundedSlab(5, 28, 0.4, 0.1), ink, 27, 0, z);
        }

        const routes = [
          new THREE.CatmullRomCurve3([
            [6, 0.82, 10.2], [12.8, 0.82, 7.4], [15, 0.82, 0], [12, 0.82, -6.6],
            [5.4, 0.82, -8.7], [-1.4, 0.82, -5.4], [-2.7, 0.82, 1.6], [1.1, 0.82, 7.8],
            [6, 0.82, 9.2], [17.2, 0.15, 6.8], [20, 0.15, -6], [12, 0.15, -14], [6, 0.15, -18],
          ].map(([x, y, z]) => new THREE.Vector3(x, y, z)), false, "centripetal"),
          new THREE.CatmullRomCurve3([
            [6, 0.15, -18], [6, 0.78, -22], [6, 0.78, -29], [6, 0.78, -35], [6, 0.15, -43],
          ].map(([x, y, z]) => new THREE.Vector3(x, y, z)), false, "centripetal"),
          new THREE.CatmullRomCurve3([
            [6, 0.15, -43], [6, 0.15, -49], [7, 0.15, -55], [10, 0.15, -61], [6, 0.15, -69],
          ].map(([x, y, z]) => new THREE.Vector3(x, y, z)), false, "centripetal"),
          new THREE.CatmullRomCurve3([
            [6, 0.15, -69], [6, 0.15, -74], [6, 0.78, -80], [8, 0.78, -85], [6, 0.78, -90], [6, 0.15, -99],
          ].map(([x, y, z]) => new THREE.Vector3(x, y, z)), false, "centripetal"),
          new THREE.CatmullRomCurve3([
            [6, 0.15, -99], [5, 0.15, -104], [5, 0.15, -108], [6, 0.98, -112], [6, 0.15, -122], [6, 0.15, -129],
          ].map(([x, y, z]) => new THREE.Vector3(x, y, z)), false, "centripetal"),
          new THREE.CatmullRomCurve3([
            [6, 0.15, -129], [6, 0.78, -134], [6, 0.78, -138], [7, 0.78, -142],
          ].map(([x, y, z]) => new THREE.Vector3(x, y, z)), false, "centripetal"),
        ];

        const drawRoute = (curve: Three.Curve<Three.Vector3>, segments = 100) => {
          mesh(geometry(new THREE.TubeGeometry(curve, segments, 0.07, 6, false)), pathBedMaterial);
          const line = mesh(geometry(new THREE.TubeGeometry(curve, segments, 0.045, 8, false)), pathMaterial);
          line.position.y = 0.068;
          line.castShadow = false;
        };
        routes.forEach((route, index) => drawRoute(route, index === 0 ? 180 : 80));

        // The loop: five places on one causeway, each physically grounded.
        const loopBase = mesh(geometry(new THREE.CylinderGeometry(10.6, 10.85, 0.62, 96)), clay, 6, 0.31, 0);
        loopBase.receiveShadow = true;
        const loopSurfaces: Three.MeshStandardMaterial[] = [];
        const surfaces = [cream, terracotta, ink, copper, cream];
        for (let index = 0; index < 5; index += 1) {
          const angle = Math.PI / 2 - (index / 5) * Math.PI * 2;
          const x = 6 + Math.cos(angle) * 8.1;
          const z = Math.sin(angle) * 8.1;
          const surface = material(surfaces[index].clone());
          loopSurfaces.push(surface);
          const station = mesh(roundedSlab(3.8, 2.5, 0.48, 1.1), surface, x, 0.68, z);
          station.rotation.y = -angle;
          const arch = makeArch(1.55 + index * 0.08, 2.3 + (index % 2) * 0.45, 0.62, surface, x, z, 1.2);
          arch.rotation.y = Math.PI / 2 - angle;
          placard(["Understand", "Discover", "Act", "Verify", "Learn"][index], x, 1.5, z + 1.6, -0.04);
        }

        // The archive: each sheet has thickness and occupies its own place.
        mesh(roundedSlab(13.6, 16.4, 0.57, 3), clay, 6, 0.08, -28);
        const panes: Three.Mesh[] = [];
        const paneMaterials: Three.MeshPhysicalMaterial[] = [];
        for (let index = 0; index < 6; index += 1) {
          const paneMaterial = material(new THREE.MeshPhysicalMaterial({ color: index === 5 ? "#ae774e" : "#dfa55f", roughness: 0.2, metalness: 0.06, transparent: true, opacity: 0.46, transmission: 0.12, thickness: 0.25, clearcoat: 0.8, ior: 1.46, depthWrite: false, side: THREE.DoubleSide }));
          paneMaterials.push(paneMaterial);
          const pane = mesh(roundedSlab(9, 0.12, 4.0 + index * 0.38, 0.05), paneMaterial, 6, 0.68, -22.5 - index * 2.15);
          panes.push(pane);
          if (index % 2 === 0) {
            placard(["Preferences", "Decisions", "Experience"][index / 2], 0, 3.7 + index * 0.38, 0.16, 0, pane);
          }
          // Fine copper footing makes the translucent sheet tangible.
          mesh(roundedSlab(9.15, 0.25, 0.1, 0.08), copper, 6, 0.67, -22.5 - index * 2.15);
        }

        // Tool outposts: the same route branches into three distinct gateways.
        const gatewaySurfaces: Three.MeshStandardMaterial[] = [];
        const outposts = [[-3, -55.5], [7, -60], [16, -54.5]];
        outposts.forEach(([x, z], index) => {
          const surface = material([cream, terracotta, ink][index].clone());
          gatewaySurfaces.push(surface);
          mesh(roundedSlab(6.2, 6, 0.42, 1.7), clay, x, 0.03, z + 0.7);
          const gate = makeArch(3.3, 5.6 + index * 0.4, 1.1, surface, x, z, 0.5);
          gate.rotation.y = index === 0 ? 0.14 : index === 2 ? -0.18 : 0;
          placard(["Connected", "Local", "Extensions"][index], x, 0.94, z + 2.2, gate.rotation.y);
          drawRoute(new THREE.CatmullRomCurve3([
            new THREE.Vector3(6, 0.15, -48), new THREE.Vector3(x, 0.15, z + 5),
            new THREE.Vector3(x, 0.53, z + 1), new THREE.Vector3(x, 0.53, z - 1.5),
            new THREE.Vector3(9, 0.15, -64),
          ], false, "centripetal"), 70);
        });

        // A recording becomes a transcript on a tangible shared workbench.
        mesh(roundedSlab(18.4, 14.6, 0.57, 2.5), clay, 7, 0.08, -84);
        const audioSurface = material(copper.clone());
        const transcriptSurface = material(paperMaterial.clone());
        const recordingSurfaces = [audioSurface, transcriptSurface];
        mesh(roundedSlab(7.2, 5.4, 0.24, 0.9), ink, 2.7, 0.69, -84);
        for (let index = 0; index < 21; index += 1) {
          const envelope = Math.sin((index / 20) * Math.PI);
          const barHeight = 0.2 + envelope * (0.5 + Math.abs(Math.sin(index * 1.93)) * 2.0);
          mesh(roundedSlab(0.16, 0.62, barHeight, 0.07), audioSurface, -0.25 + index * 0.295, 0.98, -83.7);
        }
        placard("Audio", 2.7, 1.17, -80.9, -0.03);
        for (let index = 0; index < 3; index += 1) {
          const sheet = mesh(roundedSlab(4.2, 5.9, 0.045, 0.08), transcriptSurface, 12 + index * 0.12, 0.79 + index * 0.07, -84 - index * 0.08);
          sheet.rotation.y = -0.08;
        }
        for (let index = 0; index < 5; index += 1) {
          mesh(roundedSlab(index === 0 ? 1.7 : 2.7 - (index % 2) * 0.5, 0.06, 0.012, 0.02), ink, 11.95, 1.015, -85.7 + index * 0.65);
        }
        placard("Transcript", 12.1, 1.13, -80.55, -0.08);
        drawRoute(new THREE.CatmullRomCurve3([
          new THREE.Vector3(3, 0.99, -86), new THREE.Vector3(6, 0.78, -88),
          new THREE.Vector3(9, 0.78, -88), new THREE.Vector3(12, 1.01, -86),
        ], false, "centripetal"), 45);

        // One project platform, three work surfaces, a returning shared path.
        mesh(geometry(new THREE.CylinderGeometry(4.15, 4.3, 0.88, 72)), cream, 6, 0.44, -112);
        const desks = [[-2, -109, -0.2], [14, -109, 0.22], [7, -122, 0]];
        const teamSurfaces: Three.MeshStandardMaterial[] = [];
        desks.forEach(([x, z, angle], index) => {
          const surface = material([terracotta, copper, ink][index].clone());
          teamSurfaces.push(surface);
          const table = mesh(roundedSlab(6.1, 3.6, 0.8, index === 1 ? 1.7 : 0.8), surface, x, 0.3, z);
          table.rotation.y = angle;
          placard(["Researcher", "Builder", "Reviewer"][index], x, 1.5, z + 1.65, angle);
          mesh(roundedSlab(1.5, 2.0, 0.035, 0.06), paperMaterial, x + 0.35, 1.18, z);
          drawRoute(new THREE.CatmullRomCurve3([
            new THREE.Vector3(6, 0.97, -112), new THREE.Vector3((6 + x) / 2, 0.14, (z - 112) / 2),
            new THREE.Vector3(x, 0.14, z + (index === 2 ? 2.2 : 0)), new THREE.Vector3(x, 1.17, z),
          ], false, "centripetal"), 65);
        });

        // A return lane continues through a workflow gate into the shared project.
        // It is architecture in the same room, rather than a separate end scene.
        mesh(roundedSlab(5.8, 6.4, 0.42, 1.8), clay, 21, 0.04, -125);
        makeArch(3.4, 5.9, 1.1, cream, 21, -125, 0.5).rotation.y = -0.16;
        placard("Workflow", 21, 0.95, -122.8, -0.16);
        drawRoute(new THREE.CatmullRomCurve3([
          new THREE.Vector3(6, 0.98, -112), new THREE.Vector3(19, 0.15, -114),
          new THREE.Vector3(22.5, 0.15, -119), new THREE.Vector3(21, 0.53, -125),
          new THREE.Vector3(17, 0.15, -133), new THREE.Vector3(5, 0.15, -130),
          new THREE.Vector3(2, 0.15, -120), new THREE.Vector3(6, 0.98, -112),
        ], false, "centripetal"), 120);

        // A Space gives the result a view, retained data, and useful actions.
        mesh(roundedSlab(20.2, 14.2, 0.61, 2.2), clay, 7, 0.06, -142);
        const spaceSurfaces = [cream, paperMaterial, copper].map((surface) => material(surface.clone()));
        const viewStand = new THREE.Group();
        viewStand.position.set(0.3, 0.83, -143);
        viewStand.rotation.x = -0.2;
        scene.add(viewStand);
        mesh(geometry(new THREE.BoxGeometry(4.8, 4.9, 0.24)), spaceSurfaces[0], 0, 2.5, 0, viewStand);
        mesh(geometry(new THREE.BoxGeometry(4.2, 0.64, 0.04)), ink, 0, 4.27, 0.15, viewStand);
        mesh(geometry(new THREE.BoxGeometry(1.22, 2.82, 0.04)), terracotta, -1.45, 2.36, 0.15, viewStand);
        for (let index = 0; index < 3; index += 1) {
          mesh(geometry(new THREE.BoxGeometry(2.3, 0.055, 0.035)), copper, 0.62, 3.21 - index * 0.67, 0.16, viewStand);
        }
        placard("View", 0.3, 1.13, -138.6, 0);
        for (let index = 0; index < 4; index += 1) {
          mesh(roundedSlab(4.2, 5.7, 0.19, 0.3), spaceSurfaces[1], 7, 0.77 + index * 0.48, -142.5 - index * 0.18);
          mesh(roundedSlab(0.8, 0.1, 0.055, 0.02), copper, 7, 1.01 + index * 0.48, -139.66 - index * 0.18);
        }
        placard("Data", 7, 1.15, -138.55, 0);
        for (let index = 0; index < 3; index += 1) {
          mesh(roundedSlab(4.0, 1.8, 0.3, 0.5), spaceSurfaces[2], 13.7, 0.86 + index * 0.12, -139.9 - index * 2.5);
        }
        placard("Actions", 13.7, 1.15, -138.4, 0);
        for (const x of [0.3, 7, 13.7]) {
          drawRoute(new THREE.CatmullRomCurve3([
            new THREE.Vector3(7, 0.78, -137), new THREE.Vector3(x, 0.78, -137.5), new THREE.Vector3(x, 0.78, -142),
          ], false, "centripetal"), 45);
        }

        // The same small paper artifact carries the request through every room.
        const paper = new THREE.Group();
        scene.add(paper);
        for (let index = 0; index < 3; index += 1) {
          const sheet = mesh(roundedSlab(1.45, 1.95, 0.025, 0.05), paperMaterial, index * 0.045, index * 0.045, index * 0.045, paper);
          sheet.rotation.y = index * -0.025;
        }
        mesh(roundedSlab(0.7, 0.035, 0.01, 0.012), copper, -0.15, 0.135, -0.5, paper);
        mesh(roundedSlab(0.9, 0.025, 0.01, 0.01), copper, 0, 0.135, -0.24, paper);
        mesh(roundedSlab(0.78, 0.025, 0.01, 0.01), copper, -0.06, 0.135, -0.04, paper);
        const paperPosition = new THREE.Vector3();
        const target = new THREE.Vector3();

        renderWorld = () => {
          if (!renderer || !scene || disposed || document.hidden) return;
          const bounds = host.getBoundingClientRect();
          const nextWidth = Math.max(1, Math.round(bounds.width));
          const nextHeight = Math.max(1, Math.round(bounds.height));
          const mobile = nextWidth < 800;
          if (nextWidth !== width || nextHeight !== height) {
            width = nextWidth;
            height = nextHeight;
            renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.2 : 1.5));
            renderer.setSize(width, height, false);
            camera.aspect = width / height;
            camera.fov = mobile ? 54 : 39;
            camera.setViewOffset(width, height, mobile ? 0 : -Math.round(width * 0.17), mobile ? Math.round(height * 0.25) : 0, width, height);
            camera.updateProjectionMatrix();
          }

          const value = clamp(progress.get());
          const reduced = motionQuery.matches;
          const chapter = Math.min(5, Math.floor(value * 6));
          const local = clamp(value * 6 - chapter);
          const focusZ = 4 - value * 150;
          if (reduced) {
            camera.position.set(52, 90, 65);
            target.set(5, 0, -72);
          } else {
            const lateral = 13 + Math.sin(value * Math.PI) * 3.4;
            camera.position.set(lateral, mobile ? 21 : 12.8 - value * 1.7, focusZ + (mobile ? 30 : 22));
            target.set(4.3, mobile ? 1.5 : 0.7, focusZ - 5.5);
          }
          camera.lookAt(target);

          const lightingZ = reduced ? -72 : focusZ;
          key.position.set(-14, 33, lightingZ + 18);
          key.target.position.set(6, 0, lightingZ - 6);
          rim.position.set(29, 15, lightingZ - 15);
          rim.target.position.set(5, 2, lightingZ);

          const paperChapter = reduced ? 5 : chapter;
          const paperProgress = reduced ? 1 : local;
          routes[paperChapter].getPointAt(paperProgress, paperPosition);
          paper.position.copy(paperPosition);
          paper.position.y += paperChapter === 5 ? 1.05 - paperProgress * 0.77 : 1.05;
          paper.rotation.y = reduced ? 0.22 : -0.12 + Math.min(value, 0.98) * 0.38;
          const chosen = Math.max(0, Math.floor(optionsRef.current.detail));
          loopSurfaces.forEach((surface, index) => {
            surface.emissive.set("#ce602c");
            surface.emissiveIntensity = chapter === 0 && index === chosen % 5 ? 0.21 : 0;
          });
          panes.forEach((pane, index) => {
            pane.position.y = 0.68 + (chapter === 1 && index === chosen % 6 ? 0.34 : 0);
            paneMaterials[index].opacity = chapter === 1 && index === chosen % 6 ? 0.65 : 0.46;
          });
          [gatewaySurfaces, recordingSurfaces, teamSurfaces, spaceSurfaces].forEach((group, groupIndex) => group.forEach((surface, index) => {
            surface.emissive.set("#c67037");
            surface.emissiveIntensity = chapter === groupIndex + 2 && index === chosen % group.length ? 0.19 : 0;
          }));

          host.dataset.cameraProgress = value.toFixed(4);
          canvas.dataset.cameraProgress = value.toFixed(4);
          host.dataset.worldChapter = String(chapter);
          host.dataset.worldStill = String(optionsRef.current.still || reduced);
          renderer.render(scene, camera);
          revision += 1;
          host.dataset.worldProgress = value.toFixed(4);
          host.dataset.worldFrame = String(revision);
          host.dataset.worldCamera = camera.position.toArray().map((coordinate) => coordinate.toFixed(3)).join(",");
          host.dataset.worldView = reduced ? "overview" : "journey";
          canvas.style.opacity = "1";
          canvas.dataset.worldReady = "true";
          host.dataset.worldState = "ready";
        };

        updateProgress();
        void document.fonts.ready.then(() => {
          if (disposed) return;
          labelPainters.forEach((paint) => paint());
          requestRender();
        });
      } catch {
        canvas.style.opacity = "0";
        canvas.dataset.worldReady = "false";
        host.dataset.worldState = "fallback";
        renderer?.dispose();
        renderer = undefined;
      }
    }).catch(() => {
      if (!disposed) host.dataset.worldState = "fallback";
    });

    return () => {
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
      unsubscribe();
      observer.disconnect();
      visibilityObserver.disconnect();
      motionQuery.removeEventListener("change", requestRender);
      document.removeEventListener("visibilitychange", requestRender);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      requestRenderRef.current = null;
      geometries.forEach((value) => value.dispose());
      materials.forEach((value) => value.dispose());
      textures.forEach((value) => value.dispose());
      shadowMaps.forEach((value) => value.dispose());
      scene?.clear();
      renderer?.dispose();
      renderer?.forceContextLoss();
    };
  }, [progress]);

  return (
    <div
      ref={hostRef}
      role="img"
      aria-label="A continuous terracotta world: one paper task follows an amber path through the agent loop, memory archive, tool gateways, recording and transcription, a specialist team, and a Space with its own view, data, and actions."
      data-camera-progress="0"
      data-world-state="loading"
      style={{ position: "absolute", inset: 0, overflow: "hidden", backgroundColor: "#26150f", backgroundImage: "url('/media/journey-fallback.webp')", backgroundSize: "cover", backgroundPosition: "65% center" }}
    >
      <canvas ref={canvasRef} aria-hidden="true" data-world-ready="false" style={{ display: "block", width: "100%", height: "100%", opacity: 0 }} />
    </div>
  );
}

export default JourneyWorld;
