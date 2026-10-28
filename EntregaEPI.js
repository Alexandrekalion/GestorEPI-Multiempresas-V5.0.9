import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { Camera, QrCode, User, Package, CheckCircle2, ScanFace, History, AlertTriangle, X, Loader2, UserPlus, Info, UserCheck } from 'lucide-react';
import Webcam from 'react-webcam';
import { Html5Qrcode } from 'html5-qrcode';
import axios from 'axios';
import { getAuthHeader, useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import * as faceapi from 'face-api.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { getUploadUrl, logImageError } from '@/utils/imageUtils';

import { API, withNoCache } from '@/config/api';

const formatDateTimeBR = (value) =>
  value
    ? new Date(value).toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
    : '-';


const formatDateBR = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
};

const normalizeCourseBlockStatus = (value) => {
  const statusText = String(value || '').toLowerCase();
  if (statusText.includes('venc') || statusText.includes('expir')) return 'CERTIFICADO VENCIDO';
  if (statusText.includes('inativ') || statusText === 'inactive') return 'CERTIFICADO INATIVO';
  if (statusText.includes('cancel')) return 'CERTIFICADO CANCELADO';
  if (statusText.includes('não cadastr') || statusText.includes('nao cadastr') || statusText.includes('missing') || statusText.includes('not_found') || statusText.includes('not registered')) {
    return 'CURSO NÃO CADASTRADO';
  }
  if (statusText.includes('invál') || statusText.includes('inval')) return 'CERTIFICADO INVÁLIDO';
  return value ? String(value).toUpperCase() : 'CERTIFICADO INVÁLIDO';
};

const getCourseBlockPayload = (error) => {
  const rawPayload = error?.response?.data?.detail || error?.response?.data || {};
  const payload = typeof rawPayload === 'string' ? { message: rawPayload } : rawPayload;
  const serialized = JSON.stringify(payload).toLowerCase();
  const isCourseBlock = (
    payload?.code === 'COURSE_REQUIRED' ||
    payload?.code === 'CERTIFICATE_REQUIRED' ||
    payload?.error_code === 'COURSE_REQUIRED' ||
    serialized.includes('curso') ||
    serialized.includes('certificado') ||
    serialized.includes('certificate') ||
    serialized.includes('course_required')
  );
  return isCourseBlock ? payload : null;
};

const firstValue = (...values) => values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');

const getDeliveryErrorMessage = (error) => {
  const detail = error?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (typeof detail?.message === 'string') return detail.message;
  if (typeof error?.response?.data?.message === 'string') return error.response.data.message;
  return 'Erro ao registrar';
};

const buildCourseBlockModal = (error, selectedItems = []) => {
  const payload = getCourseBlockPayload(error);
  if (!payload) return null;

  const blockedItems = payload.blocked_items || payload.blockedItems || payload.blocked_courses || payload.blockedCourses || payload.items || payload.epis || [];
  const selectedById = new Map(selectedItems.map((item) => [String(item.epi_id || item.epi_base_id || item.name), item]));
  const fallbackItem = selectedItems.length === 1 ? selectedItems[0] : {};
  const normalizedItems = (Array.isArray(blockedItems) && blockedItems.length > 0 ? blockedItems : [payload]).map((item) => {
    const selectedItem = selectedById.get(String(item.epi_id || item.epi_base_id || item.epi || item.name)) || fallbackItem;
    const course = firstValue(
      item.course,
      item.course_name,
      item.required_course,
      item.curso,
      payload.course,
      payload.course_name,
      payload.required_course,
      payload.curso
    );
    const rawStatus = firstValue(
      item.status,
      item.certificate_status,
      item.situation,
      item.situacao,
      payload.status,
      payload.certificate_status,
      payload.situation,
      payload.situacao,
      item.reason,
      payload.reason
    );
    return {
      epi: firstValue(item.epi, item.epi_name, item.name, payload.epi, payload.epi_name, selectedItem.name),
      course,
      status: normalizeCourseBlockStatus(rawStatus || item.message || payload.message),
      expirationDate: firstValue(
        item.expiration_date,
        item.expirationDate,
        item.validity_date,
        item.validade,
        payload.expiration_date,
        payload.expirationDate,
        payload.validity_date,
        payload.validade
      ),
      reason: firstValue(item.reason, item.motivo, item.message, payload.reason, payload.motivo, payload.message),
      kit: firstValue(item.kit, item.kit_name, payload.kit, payload.kit_name, selectedItem.from_kit)
    };
  });

  const primaryItem = normalizedItems[0] || {};
  const status = primaryItem.status || '';
  const courseText = primaryItem.course ? ` ${primaryItem.course}` : '';
  const hasKitBlock = normalizedItems.some((item) => item.kit);
  let message = 'O colaborador não possui certificado válido para retirada deste EPI.';

  if (status.includes('CURSO NÃO CADASTRADO')) {
    message = `O colaborador não possui o curso obrigatório${courseText} cadastrado ou válido para retirada deste EPI.`;
  } else if (status.includes('VENCIDO')) {
    message = 'O certificado obrigatório para este EPI está vencido.';
  } else if (status.includes('INATIVO') || status.includes('CANCELADO')) {
    message = 'O certificado obrigatório para este EPI está inativo ou cancelado.';
  }

  return {
    title: hasKitBlock ? 'ENTREGA DO KIT BLOQUEADA' : 'ENTREGA BLOQUEADA',
    message,
    items: normalizedItems,
    closingMessage: hasKitBlock
      ? 'A entrega do kit não poderá ser concluída até a regularização do certificado.'
      : 'A entrega não poderá ser concluída até a regularização do certificado.'
  };
};

const LIVE_DETECTION_CONFIDENCE = 0.38;
const FACIAL_AUTO_APPROVE_THRESHOLD = 0.80;
const FACIAL_REVIEW_THRESHOLD = 0.70;
const LIVE_STABILITY_TIME = 80;
const LIVE_MAX_AUTO_ATTEMPTS = 9999;
const LIVE_DETECTION_INTERVAL = 100;
const DETECTION_GRACE_MS = 350;
const STABILITY_TIMER_DELAY = 20;
const FRAME_BURST_COUNT = 3;
const FRAME_BURST_DELAY = 120;
const CENTER_REGION = { left: 0.25, top: 0.14, width: 0.50, height: 0.68 };
const CENTER_TOLERANCE_X = CENTER_REGION.width / 2;
const CENTER_TOLERANCE_Y = CENTER_REGION.height / 2;
const MIN_FACE_AREA_RATIO = 0.018;
const TARGET_FACE_AREA_RATIO = 0.20;
const MOTION_TOLERANCE_RATIO = 0.08;
const MIN_FACE_CONTAINMENT_RATIO = 0.80;
const MIN_FACE_BRIGHTNESS = 35;
const MAX_FACE_BRIGHTNESS = 245;
const MIN_FACE_SHARPNESS = 6;
const MAX_FACE_DARK_RATIO = 0.65;
const MAX_FACE_BRIGHT_RATIO = 0.65;
const MAX_FACE_SATURATED_RATIO = 0.50;
const MULTI_FACE_MESSAGE = 'Posicione apenas um colaborador em frente à câmera.';
const INSUFFICIENT_STOCK_MESSAGE = 'Estoque insuficiente para realizar esta entrega.';

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const normalizeSize = (value) => (value ? String(value).trim().toUpperCase() : '');
const formatVariationLabel = (variation) => {
  if (!variation) return 'Selecione a variação';
  const parts = [
    variation.size || variation.tamanho ? `Tam. ${variation.size || variation.tamanho}` : null,
    variation.ca_number || variation.ca ? `CA ${variation.ca_number || variation.ca}` : null,
    variation.batch || variation.lote ? `Lote ${variation.batch || variation.lote}` : null,
    variation.brand || variation.marca,
    variation.model || variation.modelo,
    `Estoque ${variation.current_stock ?? variation.quantidade_estoque ?? 0}`
  ].filter(Boolean);
  return parts.join(' | ');
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowMs = () => (typeof performance !== 'undefined' && typeof performance.now === 'function'
  ? performance.now()
  : Date.now());
const roundTelemetry = (value) => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null);
const createTechnicalAttemptId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `facial-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const loadImageFromDataUrl = (imageSrc) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = imageSrc;
  });

const getFaceGeometry = (box, width, height) => {
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const faceAreaRatio = (box.width * box.height) / (width * height);
  const offsetX = Math.abs(centerX - width / 2) / width;
  const offsetY = Math.abs(centerY - height / 2) / height;

  return {
    centerX,
    centerY,
    faceAreaRatio,
    offsetX,
    offsetY
  };
};

const isFaceInsideCentralRegion = (box, width, height) => {
  if (!box || !width || !height) return false;
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const left = width * CENTER_REGION.left;
  const top = height * CENTER_REGION.top;
  const right = left + width * CENTER_REGION.width;
  const bottom = top + height * CENTER_REGION.height;
  const intersectionWidth = Math.max(0, Math.min(box.x + box.width, right) - Math.max(box.x, left));
  const intersectionHeight = Math.max(0, Math.min(box.y + box.height, bottom) - Math.max(box.y, top));
  const containment = (intersectionWidth * intersectionHeight) / Math.max(box.width * box.height, 1);
  return centerX >= left && centerX <= right && centerY >= top && centerY <= bottom
    && containment >= MIN_FACE_CONTAINMENT_RATIO;
};

const chooseCentralFace = (detections, width, height) => {
  const centralFaces = (detections || [])
    .filter((detection) => isFaceInsideCentralRegion(detection.box, width, height))
    .sort((left, right) => ((right.box?.width || 0) * (right.box?.height || 0)) - ((left.box?.width || 0) * (left.box?.height || 0)));

  return {
    centralFaces,
    bestFace: centralFaces[0] || null,
    blockedByMultipleFaces: centralFaces.length > 1
  };
};

const cropImageToCentralRegion = (img, mimeType = 'image/jpeg', quality = 0.82) => {
  const sourceWidth = img.naturalWidth || img.videoWidth || img.width;
  const sourceHeight = img.naturalHeight || img.videoHeight || img.height;
  const cropX = Math.round(sourceWidth * CENTER_REGION.left);
  const cropY = Math.round(sourceHeight * CENTER_REGION.top);
  const cropWidth = Math.round(sourceWidth * CENTER_REGION.width);
  const cropHeight = Math.round(sourceHeight * CENTER_REGION.height);
  const outputWidth = Math.min(420, cropWidth);
  const scale = outputWidth / cropWidth;
  const outputHeight = Math.round(cropHeight * scale);

  const canvas = document.createElement('canvas');
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, cropX, cropY, cropWidth, cropHeight, 0, 0, outputWidth, outputHeight);
  return canvas.toDataURL(mimeType, quality);
};

const getItemAvailableStock = (item) => {
  const stock = Number(item?.available_stock ?? item?.current_stock ?? 0);
  return Number.isFinite(stock) ? stock : 0;
};

const getItemQuantity = (item) => {
  const quantity = Number(item?.quantity ?? 1);
  return Number.isFinite(quantity) ? Math.max(1, quantity) : 1;
};

const getItemStockIssue = (item, deliveryType) => {
  if (deliveryType === 'return') return null;
  const stock = getItemAvailableStock(item);
  const quantity = getItemQuantity(item);
  if (stock <= 0) return 'EPI sem estoque disponível.';
  if (quantity > stock) return INSUFFICIENT_STOCK_MESSAGE;
  return null;
};

const isActiveStatus = (status) => !['inativo', 'inactive'].includes(String(status || 'ativo').toLowerCase());
const isInactiveEmployee = (employee) => ['inativo', 'inactive'].includes(String(employee?.status || 'active').toLowerCase());

const getAvailableVariations = (epi) => (
  (epi?.variations || []).filter((variation) => isActiveStatus(variation.status) && Number(variation.current_stock ?? variation.stock ?? 0) > 0)
);

const getEpiSelectionIssue = (epi, deliveryType) => {
  if (!epi) return 'EPI não encontrado.';
  if (!isActiveStatus(epi.status)) return 'EPI inativo.';
  if (deliveryType === 'return') return null;

  const variations = epi.variations || [];
  if (variations.length > 0 && getAvailableVariations(epi).length === 0) {
    return 'Variação sem estoque.';
  }

  const stock = Number(epi.current_stock ?? 0);
  if (variations.length === 0 && (!Number.isFinite(stock) || stock <= 0)) {
    return 'EPI sem estoque disponível.';
  }

  return null;
};

const computeImageMetrics = (img, box = null) => {
  const canvas = document.createElement('canvas');
  const sourceX = box ? Math.max(0, box.x) : 0;
  const sourceY = box ? Math.max(0, box.y) : 0;
  const sourceWidth = box ? Math.min(img.width - sourceX, box.width) : img.width;
  const sourceHeight = box ? Math.min(img.height - sourceY, box.height) : img.height;
  const maxWidth = 160;
  const scale = Math.min(1, maxWidth / Math.max(sourceWidth, 1));
  canvas.width = Math.max(32, Math.round(sourceWidth * scale));
  canvas.height = Math.max(24, Math.round(sourceHeight * scale));

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);

  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let brightnessSum = 0;
  let detailSum = 0;
  let darkPixels = 0;
  let brightPixels = 0;
  let saturatedPixels = 0;
  let samples = 0;

  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const idx = (y * width + x) * 4;
      const rightIdx = (y * width + (x + 1)) * 4;
      const bottomIdx = ((y + 1) * width + x) * 4;
      const gray = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      const rightGray = 0.299 * data[rightIdx] + 0.587 * data[rightIdx + 1] + 0.114 * data[rightIdx + 2];
      const bottomGray = 0.299 * data[bottomIdx] + 0.587 * data[bottomIdx + 1] + 0.114 * data[bottomIdx + 2];

      brightnessSum += gray;
      detailSum += Math.abs(gray - rightGray) + Math.abs(gray - bottomGray);
      if (gray < 35) darkPixels += 1;
      if (gray > 245) brightPixels += 1;
      if (Math.max(data[idx], data[idx + 1], data[idx + 2]) >= 250
        && Math.min(data[idx], data[idx + 1], data[idx + 2]) >= 245) saturatedPixels += 1;
      samples += 1;
    }
  }

  const meanLuma = samples > 0 ? brightnessSum / samples : 0;
  const brightness = meanLuma / 255;
  const sharpness = samples > 0 ? detailSum / (samples * 2) : 0;
  const darkRatio = samples > 0 ? darkPixels / samples : 1;
  const brightRatio = samples > 0 ? brightPixels / samples : 1;
  const saturatedRatio = samples > 0 ? saturatedPixels / samples : 1;

  return {
    brightness,
    meanLuma,
    sharpness,
    darkRatio,
    brightRatio,
    saturatedRatio
  };
};

const scoreFrameQuality = (img, detection) => {
  const box = detection?.detection?.box || detection?.box;
  const geometry = getFaceGeometry(box, img.width, img.height);
  const metrics = computeImageMetrics(img, box);
  const { brightness, sharpness } = metrics;

  const detectionScore = detection?.detection?.score || detection?.score || 0;
  const centerDistance = Math.sqrt((geometry.offsetX * 2) ** 2 + (geometry.offsetY * 2) ** 2);
  const centerScore = clamp(1 - centerDistance / 0.9);
  const sizeScore = clamp(1 - Math.abs(geometry.faceAreaRatio - TARGET_FACE_AREA_RATIO) / TARGET_FACE_AREA_RATIO);
  const lightingScore = clamp(1 - Math.abs(brightness - 0.55) / 0.35);
  const sharpnessScore = clamp((sharpness - 8) / 28);
  const usable = metrics.meanLuma >= MIN_FACE_BRIGHTNESS
    && metrics.meanLuma <= MAX_FACE_BRIGHTNESS
    && metrics.sharpness >= MIN_FACE_SHARPNESS
    && metrics.darkRatio <= MAX_FACE_DARK_RATIO
    && metrics.brightRatio <= MAX_FACE_BRIGHT_RATIO
    && metrics.saturatedRatio <= MAX_FACE_SATURATED_RATIO;

  return {
    totalScore: (detectionScore * 0.35) + (centerScore * 0.20) + (sizeScore * 0.15)
      + (sharpnessScore * 0.15) + (lightingScore * 0.15),
    detectionScore,
    centerScore,
    sizeScore,
    sharpnessScore,
    lightingScore,
    faceAreaRatio: geometry.faceAreaRatio,
    containmentRatio: isFaceInsideCentralRegion(box, img.width, img.height),
    usable,
    ...metrics
  };
};

const FAST_DETECTION_OPTIONS = new faceapi.TinyFaceDetectorOptions({
  inputSize: 128,
  scoreThreshold: 0.45
});

const RECOGNITION_EMBEDDING_OPTIONS = new faceapi.TinyFaceDetectorOptions({
  inputSize: 224,
  scoreThreshold: 0.50
});

// ============================================
// CONFIGURAÇÕES OTIMIZADAS PARA PCs FRACOS
// ============================================

// Detector LEVE para detecção contínua (MUITO RÁPIDO)
const LEGACY_DETECTION_OPTIONS = new faceapi.TinyFaceDetectorOptions({
  inputSize: 128,        // 128 = ULTRA LEVE para detecção contínua
  scoreThreshold: 0.55   // Confiança mínima equilibrada
});

// Configurações para embedding final (só roda 1x após validação)
const LEGACY_EMBEDDING_OPTIONS = new faceapi.TinyFaceDetectorOptions({
  inputSize: 224,        // Reduzido de 320 para melhor performance
  scoreThreshold: 0.6
});

// Thresholds otimizados
const SIMILARITY_THRESHOLD = FACIAL_AUTO_APPROVE_THRESHOLD; // legado isolado: fluxo ativo usa backend
const DETECTION_CONFIDENCE = 0.65;   // Confiança mínima do rosto (ajustado)
const STABILITY_TIME = 1000;         // ms de estabilidade antes de capturar (aumentado)
const MAX_AUTO_ATTEMPTS = 1;         // Máximo de tentativas automáticas (reduzido)
const DETECTION_INTERVAL = 350;      // ms entre detecções (aumentado de 200)

export default function EntregaEPI() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isCounterUser = user?.username === 'balcao_jac';
  const [step, setStep] = useState('facial');
  const [allEmployees, setAllEmployees] = useState([]);
  const [selectedEmployee, setSelectedEmployee] = useState(null);
  const [showWebcam, setShowWebcam] = useState(true);
  const [showQRScanner, setShowQRScanner] = useState(false);
  const [facialMatch, setFacialMatch] = useState(null);
  const [epis, setEpis] = useState([]);
  const [kits, setKits] = useState([]);
  const [selectedItems, setSelectedItems] = useState([]);
  const [deliverySuggestion, setDeliverySuggestion] = useState(null);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [counterAttendants, setCounterAttendants] = useState([]);
  const [selectedAttendantId, setSelectedAttendantId] = useState('');
  const [deliveryType, setDeliveryType] = useState('delivery');
  const [loading, setLoading] = useState(false);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [employeeHistory, setEmployeeHistory] = useState([]);
  const [employeeCurrentItems, setEmployeeCurrentItems] = useState([]);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);
  const [capturedPhoto, setCapturedPhoto] = useState(null);
  const [loadingStatus, setLoadingStatus] = useState('');
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [notFoundMessage, setNotFoundMessage] = useState(null);
  const [courseBlockModal, setCourseBlockModal] = useState(null);
  const [autoAttempts, setAutoAttempts] = useState(0);
  const [autoCaptureEnabled, setAutoCaptureEnabled] = useState(true);
  const [runtimeBackend, setRuntimeBackend] = useState('AUTO');
  const [similarityScore, setSimilarityScore] = useState(0);
  const [similarityMessage, setSimilarityMessage] = useState('Aguardando validação facial');
  const [cameraFacingMode, setCameraFacingMode] = useState('user');
  
  // Estados para detecção em tempo real
  const [faceDetected, setFaceDetected] = useState(false);
  const [faceValid, setFaceValid] = useState(false);
  const [detectionScore, setDetectionScore] = useState(0);
  const [stabilityProgress, setStabilityProgress] = useState(0);
  const [isProcessingEmbedding, setIsProcessingEmbedding] = useState(false);
  const [guidanceMessage, setGuidanceMessage] = useState('Aguardando rosto');
  
  // Cache de templates faciais
  const [facialTemplatesCache, setFacialTemplatesCache] = useState([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [templateCount, setTemplateCount] = useState(0);
  
  // Estado para termo de consentimento LGPD - removido pois agora é no cadastro da biometria
  // const [showConsentDialog, setShowConsentDialog] = useState(false);
  // const [consentAccepted, setConsentAccepted] = useState(false);
  
  // Refs
  const webcamRef = useRef(null);
  const qrScannerRef = useRef(null);
  const detectionIntervalRef = useRef(null);
  const detectionInFlightRef = useRef(false);
  const stabilityTimerRef = useRef(null);
  const processingRef = useRef(false);  // LOCK DE PROCESSAMENTO
  const lastValidDetectionRef = useRef(null);
  const autoAttemptsRef = useRef(0);
  const cameraSessionStartedRef = useRef(nowMs());
  const cameraReadyAtRef = useRef(null);
  const facialAttemptSequenceRef = useRef(0);
  const detectionStateRef = useRef({
    lastAcceptedAt: 0,
    stableSince: null,
    lastBox: null
  });
  const pendingConfirmationRef = useRef(null);

  useEffect(() => {
    // Carregar tudo em paralelo
    Promise.all([
      loadFaceModels(),
      fetchEPIs(),
      fetchKits(),
      fetchAllEmployees()
    ]);
    
    // CRÍTICO: Cleanup ao desmontar componente
    return () => {
      if (detectionIntervalRef.current) {
        clearInterval(detectionIntervalRef.current);
        detectionIntervalRef.current = null;
      }
      if (stabilityTimerRef.current) {
        clearTimeout(stabilityTimerRef.current);
        stabilityTimerRef.current = null;
      }
      
      // Parar media stream
      if (webcamRef.current?.video?.srcObject) {
        const stream = webcamRef.current.video.srcObject;
        stream.getTracks().forEach(track => track.stop());
      }
    };
  }, []);
  
  // Carregar templates quando modelos forem carregados
  useEffect(() => {
    if (modelsLoaded && !templatesLoaded) {
      setTemplatesLoaded(true);
    }
  }, [modelsLoaded, templatesLoaded]);

  useEffect(() => {
    if (selectedEmployee && (step === 'delivery' || facialMatch?.verified)) {
      fetchEPIs();
      fetchKits();
      fetchDeliverySuggestions(selectedEmployee.id);
    }
  }, [selectedEmployee, step, facialMatch?.verified]);

  useEffect(() => {
    if (isCounterUser) {
      fetchCounterAttendants();
    }
  }, [isCounterUser]);

  useEffect(() => {
    setSelectedAttendantId('');
  }, [selectedEmployee?.id]);

  const configureTensorflowBackend = async () => {
    try {
      const tf = faceapi.tf;
      if (!tf) {
        setRuntimeBackend('AUTO');
        return;
      }

      if (typeof tf.enableProdMode === 'function') {
        tf.enableProdMode();
      }

      const preferredBackends = ['webgl', 'wasm', 'cpu'];
      for (const backend of preferredBackends) {
        try {
          const changed = await tf.setBackend(backend);
          if (changed !== false) {
            break;
          }
        } catch (backendError) {
          console.warn(`Backend ${backend} indisponível:`, backendError?.message || backendError);
        }
      }

      if (typeof tf.ready === 'function') {
        await tf.ready();
      }

      setRuntimeBackend((tf.getBackend?.() || 'AUTO').toUpperCase());
    } catch (error) {
      console.warn('Nao foi possivel configurar backend do TensorFlow.js:', error);
      setRuntimeBackend('AUTO');
    }
  };

  const loadFaceModels = async () => {
    try {
      setLoadingStatus('Carregando IA de reconhecimento...');
      setLoadingProgress(10);
      await configureTensorflowBackend();
      const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
      await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
      setModelsLoaded(true);
      setLoadingProgress(40);
      setLoadingStatus('');
    } catch (error) {
      console.error('Erro ao carregar modelos faciais:', error);
      toast.error('Erro ao carregar modelos de reconhecimento facial');
    }
  };
  
  // OTIMIZADO: Buscar templates apenas de colaboradores ativos
  const loadAllFacialTemplates = useCallback(async () => {
    try {
      setLoadingStatus('Preparando camera...');
      setLoadingProgress(80);
      setFacialTemplatesCache([]);
      setTemplateCount(allEmployees.length || 0);
      setTemplatesLoaded(true);
      setLoadingProgress(100);
      setLoadingStatus('');
    } catch (error) {
      console.error('Erro ao carregar templates:', error);
      setLoadingStatus('');
      setLoadingProgress(100);
      setTemplatesLoaded(true);
    }
  }, [allEmployees.length]);

  // ========================================
  // DETECÇÃO EM TEMPO REAL (OTIMIZADA)
  // ========================================
  
  useEffect(() => {
    if (modelsLoaded && templatesLoaded && showWebcam && !loading && !isProcessingEmbedding) {
      startContinuousDetection();
    }
    
    return () => {
      stopContinuousDetection();
    };
  }, [modelsLoaded, templatesLoaded, showWebcam, loading, isProcessingEmbedding]);

  const startContinuousDetection = () => {
    if (detectionIntervalRef.current) return;
    
    // O intervalo é mantido, mas a trava impede detecções concorrentes.
    detectionIntervalRef.current = setInterval(async () => {
      await detectFaceInRealTimeV2();
    }, LIVE_DETECTION_INTERVAL);
  };

  const stopContinuousDetection = () => {
    if (detectionIntervalRef.current) {
      clearInterval(detectionIntervalRef.current);
      detectionIntervalRef.current = null;
    }
    if (stabilityTimerRef.current) {
      clearTimeout(stabilityTimerRef.current);
      stabilityTimerRef.current = null;
    }
  };

  // Validar vídeo antes da detecção
  const isVideoReady = () => {
    if (!webcamRef.current) return false;
    const video = webcamRef.current.video;
    const ready = video &&
      video.readyState >= 2 &&
      video.videoWidth > 0 &&
      video.videoHeight > 0;
    if (ready && cameraReadyAtRef.current === null) {
      cameraReadyAtRef.current = nowMs();
    }
    return ready;
  };

  // Detecção LEVE - SÓ detecta rosto, NÃO gera embedding
  const resetDetectionStateV2 = useCallback(() => {
    setFaceValid(false);
    setStabilityProgress(0);
    setDetectionScore(0);
    lastValidDetectionRef.current = null;
    detectionStateRef.current = {
      lastAcceptedAt: 0,
      stableSince: null,
      lastBox: null
    };
    if (stabilityTimerRef.current) {
      clearTimeout(stabilityTimerRef.current);
      stabilityTimerRef.current = null;
    }
  }, []);

  const isMovementTolerable = useCallback((previousBox, currentBox, videoWidth, videoHeight) => {
    if (!previousBox || !currentBox) return false;

    const previousCenterX = previousBox.x + previousBox.width / 2;
    const previousCenterY = previousBox.y + previousBox.height / 2;
    const currentCenterX = currentBox.x + currentBox.width / 2;
    const currentCenterY = currentBox.y + currentBox.height / 2;

    const centerDeltaX = Math.abs(currentCenterX - previousCenterX) / videoWidth;
    const centerDeltaY = Math.abs(currentCenterY - previousCenterY) / videoHeight;
    const widthDelta = Math.abs(currentBox.width - previousBox.width) / Math.max(previousBox.width, 1);
    const heightDelta = Math.abs(currentBox.height - previousBox.height) / Math.max(previousBox.height, 1);

    return (
      centerDeltaX <= MOTION_TOLERANCE_RATIO &&
      centerDeltaY <= MOTION_TOLERANCE_RATIO &&
      widthDelta <= 0.18 &&
      heightDelta <= 0.18
    );
  }, []);

  const resolveEmployeeById = useCallback(async (employeeId) => {
    const cachedEmployee = allEmployees.find((employee) => employee.id === employeeId);
    if (cachedEmployee) {
      return cachedEmployee;
    }

    const response = await axios.get(`${API}/employees/${employeeId}`, { headers: getAuthHeader() });
    return response.data;
  }, [allEmployees]);

  const finalizeSuccessfulMatch = useCallback(async (employee, bestFrame, identifyResult, extra = {}) => {
    if (isInactiveEmployee(employee) || identifyResult?.status === 'blocked') {
      const message = identifyResult?.message || 'Colaborador identificado, porem esta inativo e nao pode receber EPI.';
      setSimilarityMessage(message);
      setGuidanceMessage(message);
      toast.error(message);
      setLoading(false);
      setIsProcessingEmbedding(false);
      setAutoCaptureEnabled(true);
      return;
    }
    const finalPercent = Math.round((identifyResult?.similarity_score || 0) * 100);
    setCapturedPhoto(bestFrame.imageSrc);
    setSimilarityScore(finalPercent);
    setSimilarityMessage(identifyResult?.message || 'Reconhecimento facial aprovado');
    setGuidanceMessage('Concluído');
    setFacialMatch({
      score: identifyResult?.similarity_score || 0,
      verified: true,
      status: identifyResult?.status || 'approved',
      message: identifyResult?.message || '',
      detectionConfidence: identifyResult?.detection_confidence || bestFrame.quality.detectionScore,
      frameQuality: bestFrame.quality.totalScore,
      poseLabel: identifyResult?.matched_pose_label || 'frontal',
      secondCaptureUsed: Boolean(extra.secondCaptureUsed),
      livenessStatus: extra.livenessStatus || (extra.secondCaptureUsed ? 'approved' : 'not_required')
    });
    setSelectedEmployee(employee);
    pendingConfirmationRef.current = null;
    await fetchEmployeeHistory(employee.id);

    autoAttemptsRef.current = 0;
    setAutoAttempts(0);
    setAutoCaptureEnabled(true);
    setLoadingStatus('');
    setLoading(false);
    setIsProcessingEmbedding(false);

    toast.success(`${employee.full_name} identificado`);

    await wait(150);
    setShowWebcam(false);
    setStep('delivery');
  }, []);

  const captureBestFrameBurst = useCallback(async (attemptId) => {
    const burstStartedAt = nowMs();
    const frames = [];
    const frameTelemetry = [];

    for (let index = 0; index < FRAME_BURST_COUNT; index += 1) {
      const frameStartedAt = nowMs();
      const imageSrc = webcamRef.current?.getScreenshot();
      if (!imageSrc) {
        frameTelemetry.push({
          frame_index: index,
          capture_ms: roundTelemetry(nowMs() - frameStartedAt),
          total_ms: roundTelemetry(nowMs() - frameStartedAt),
          quality_pass: false,
          rejection_reason: 'captura_indisponivel'
        });
        await wait(FRAME_BURST_DELAY);
        continue;
      }

      try {
        const captureFinishedAt = nowMs();
        const decodeStartedAt = captureFinishedAt;
        const img = await loadImageFromDataUrl(imageSrc);
        const decodeFinishedAt = nowMs();
        const detectionStartedAt = decodeFinishedAt;
        const detections = await faceapi.detectAllFaces(img, RECOGNITION_EMBEDDING_OPTIONS);
        const detectionFinishedAt = nowMs();
        const { centralFaces, bestFace, blockedByMultipleFaces } = chooseCentralFace(detections, img.width, img.height);

        if (blockedByMultipleFaces) {
          frameTelemetry.push({
            frame_index: index,
            capture_ms: roundTelemetry(captureFinishedAt - frameStartedAt),
            decode_ms: roundTelemetry(decodeFinishedAt - decodeStartedAt),
            detection_ms: roundTelemetry(detectionFinishedAt - detectionStartedAt),
            total_ms: roundTelemetry(nowMs() - frameStartedAt),
            quality_pass: false,
            rejection_reason: 'multiplos_rostos'
          });
          return {
            blockedReason: MULTI_FACE_MESSAGE,
            frames: [],
            telemetry: { attempt_id: attemptId, burst_ms: roundTelemetry(nowMs() - burstStartedAt), frame_telemetry: frameTelemetry }
          };
        }

        if (bestFace?.box) {
          const compressionStartedAt = nowMs();
          const croppedImageSrc = cropImageToCentralRegion(img);
          const compressionFinishedAt = nowMs();
          const quality = scoreFrameQuality(img, bestFace);
          if (!quality.usable) {
            console.debug('Frame rejeitado no pre-filtro de qualidade facial.');
            frameTelemetry.push({
              frame_index: index,
              capture_ms: roundTelemetry(captureFinishedAt - frameStartedAt),
              decode_ms: roundTelemetry(decodeFinishedAt - decodeStartedAt),
              detection_ms: roundTelemetry(detectionFinishedAt - detectionStartedAt),
              compression_ms: roundTelemetry(compressionFinishedAt - compressionStartedAt),
              total_ms: roundTelemetry(nowMs() - frameStartedAt),
              quality_pass: false,
              rejection_reason: 'filtro_qualidade'
            });
          } else {
            frames.push({
              imageSrc: croppedImageSrc,
              originalImageSrc: imageSrc,
              detection: bestFace,
              quality
            });
            frameTelemetry.push({
              frame_index: index,
              capture_ms: roundTelemetry(captureFinishedAt - frameStartedAt),
              decode_ms: roundTelemetry(decodeFinishedAt - decodeStartedAt),
              detection_ms: roundTelemetry(detectionFinishedAt - detectionStartedAt),
              compression_ms: roundTelemetry(compressionFinishedAt - compressionStartedAt),
              total_ms: roundTelemetry(nowMs() - frameStartedAt),
              quality_pass: true
            });
          }
        } else if ((detections || []).length > 0 && centralFaces.length === 0) {
          console.debug('Rosto fora da area central ignorado.');
          frameTelemetry.push({
            frame_index: index,
            capture_ms: roundTelemetry(captureFinishedAt - frameStartedAt),
            decode_ms: roundTelemetry(decodeFinishedAt - decodeStartedAt),
            detection_ms: roundTelemetry(detectionFinishedAt - detectionStartedAt),
            total_ms: roundTelemetry(nowMs() - frameStartedAt),
            quality_pass: false,
            rejection_reason: 'fora_roi'
          });
        } else {
          frameTelemetry.push({
            frame_index: index,
            capture_ms: roundTelemetry(captureFinishedAt - frameStartedAt),
            decode_ms: roundTelemetry(decodeFinishedAt - decodeStartedAt),
            detection_ms: roundTelemetry(detectionFinishedAt - detectionStartedAt),
            total_ms: roundTelemetry(nowMs() - frameStartedAt),
            quality_pass: false,
            rejection_reason: 'nenhum_rosto'
          });
        }
      } catch (error) {
        console.warn('Frame ignorado durante burst:', error?.message || error);
        frameTelemetry.push({
          frame_index: index,
          total_ms: roundTelemetry(nowMs() - frameStartedAt),
          quality_pass: false,
          rejection_reason: 'erro_processamento'
        });
      }

      if (index < FRAME_BURST_COUNT - 1) {
        await wait(FRAME_BURST_DELAY);
      }
    }

    if (frames.length === 0) {
      return {
        best: null,
        frames: [],
        telemetry: {
          attempt_id: attemptId,
          camera_ready_ms: cameraReadyAtRef.current === null ? null : roundTelemetry(cameraReadyAtRef.current - cameraSessionStartedRef.current),
          burst_ms: roundTelemetry(nowMs() - burstStartedAt),
          frames_captured: FRAME_BURST_COUNT,
          frames_usable: 0,
          frame_telemetry: frameTelemetry
        }
      };
    }

    const sortedFrames = frames.sort((left, right) => right.quality.totalScore - left.quality.totalScore);
    return {
      best: sortedFrames[0],
      frames: sortedFrames,
      telemetry: {
        attempt_id: attemptId,
        camera_ready_ms: cameraReadyAtRef.current === null ? null : roundTelemetry(cameraReadyAtRef.current - cameraSessionStartedRef.current),
        burst_ms: roundTelemetry(nowMs() - burstStartedAt),
        frames_captured: FRAME_BURST_COUNT,
        frames_usable: frames.length,
        frame_telemetry: frameTelemetry
      }
    };
  }, []);

  const resetAfterProcessV2 = useCallback((wasAutoCapture = false, options = {}) => {
    setIsProcessingEmbedding(false);
    setLoading(false);
    setLoadingStatus('');
    resetDetectionStateV2();

    if (!options.preservePendingConfirmation) {
      pendingConfirmationRef.current = null;
    }

    const restartDelay = options.restartDelay ?? 500;

    if (wasAutoCapture && autoAttemptsRef.current >= LIVE_MAX_AUTO_ATTEMPTS && !options.forceRestart) {
      setTimeout(() => {
        if (showWebcam) startContinuousDetection();
      }, 1200);
      return;
    }

    setTimeout(() => {
      if (showWebcam) startContinuousDetection();
    }, restartDelay);
  }, [resetDetectionStateV2, showWebcam]);

  const captureAndIdentifyV2 = useCallback(async (isAutoCapture = false) => {
    if (processingRef.current || isProcessingEmbedding || !webcamRef.current) {
      return;
    }

    processingRef.current = true;
    stopContinuousDetection();
    await wait(40);
    isVideoReady();

    facialAttemptSequenceRef.current += 1;
    const attemptSequence = facialAttemptSequenceRef.current;
    const attemptId = createTechnicalAttemptId();
    const flowStartedAt = nowMs();

    setIsProcessingEmbedding(true);
    setLoading(true);
    setLoadingStatus('Processando');

    try {
      const burst = await captureBestFrameBurst(attemptId);
      if (burst?.blockedReason) {
        setSimilarityMessage(burst.blockedReason);
        setNotFoundMessage(burst.blockedReason);
        resetAfterProcessV2(isAutoCapture, { restartDelay: 250, forceRestart: true });
        return;
      }
      if (!burst?.best) {
        setSimilarityMessage('Posicione o rosto dentro da área central.');
        resetAfterProcessV2(isAutoCapture, { restartDelay: 80, forceRestart: true });
        return;
      }
      const bestFrame = burst.best;
      const clientTelemetry = {
        ...(burst.telemetry || {}),
        attempt_id: attemptId,
        attempt_sequence: attemptSequence
      };
      const requestStartedAt = nowMs();

      const identifyResponse = await axios.post(
        `${API}/facial/identify-burst`,
        {
          images_base64: burst.frames.map((frame) => frame.imageSrc),
          client_telemetry: clientTelemetry
        },
        { headers: getAuthHeader() }
      );
      const responseMs = nowMs() - requestStartedAt;
      const identifyResult = identifyResponse.data;
      const percentMatch = Math.round((identifyResult?.similarity_score || 0) * 100);
      const publishPerformance = (resultStatus) => {
        void axios.post(
          `${API}/facial/performance`,
          {
            attempt_id: attemptId,
            response_ms: roundTelemetry(responseMs),
            ui_result_ms: roundTelemetry(nowMs() - flowStartedAt),
            result_status: resultStatus,
            attempt_sequence: attemptSequence
          },
          { headers: getAuthHeader() }
        ).catch((error) => {
          const status = error?.response?.status;
          if (process.env.NODE_ENV !== 'production' || (status && status >= 500)) {
            console.debug('Telemetria facial indisponivel', { status: status || 'network' });
          }
        });
      };

      if (identifyResult.status === 'approved' && identifyResult.employee_id) {
        const employee = await resolveEmployeeById(identifyResult.employee_id);
        await finalizeSuccessfulMatch(employee, bestFrame, identifyResult, {
          secondCaptureUsed: false
        });
        publishPerformance('approved');
        return;
      }

      setSimilarityScore(percentMatch);
      setSimilarityMessage(identifyResult.message || 'Procurando colaborador automaticamente');
      setNotFoundMessage(null);
      publishPerformance(identifyResult.status || 'retry');
      resetAfterProcessV2(isAutoCapture, { restartDelay: 80, forceRestart: true });
    } catch (error) {
      console.error('Erro na identificacao facial:', error);
      setSimilarityMessage('Nova tentativa automatica em andamento');
      resetAfterProcessV2(isAutoCapture, { restartDelay: 180, forceRestart: true });
    } finally {
      processingRef.current = false;
    }
  }, [
    captureBestFrameBurst,
    finalizeSuccessfulMatch,
    isProcessingEmbedding,
    resetAfterProcessV2,
    resolveEmployeeById
  ]);

  const scheduleAutoCaptureV2 = useCallback(() => {
    if (
      stabilityTimerRef.current ||
      processingRef.current ||
      !autoCaptureEnabled ||
      autoAttemptsRef.current >= LIVE_MAX_AUTO_ATTEMPTS
    ) {
      return;
    }

    stabilityTimerRef.current = setTimeout(() => {
      stabilityTimerRef.current = null;
      if (!processingRef.current && autoAttemptsRef.current < LIVE_MAX_AUTO_ATTEMPTS) {
        autoAttemptsRef.current += 1;
        setAutoAttempts(autoAttemptsRef.current);
        captureAndIdentifyV2(true);
      }
    }, STABILITY_TIMER_DELAY);
  }, [autoCaptureEnabled, captureAndIdentifyV2]);

  const detectFaceInRealTimeV2 = useCallback(async () => {
    if (processingRef.current || loading || isProcessingEmbedding) return;
    if (detectionInFlightRef.current) return;
    detectionInFlightRef.current = true;

    try {
      if (!isVideoReady()) {
        setGuidanceMessage('Aguardando rosto');
        return;
      }

      const video = webcamRef.current.video;
      const detections = await faceapi.detectAllFaces(video, FAST_DETECTION_OPTIONS);
      const { bestFace: detection, blockedByMultipleFaces } = chooseCentralFace(detections, video.videoWidth, video.videoHeight);
      const now = Date.now();

      if (blockedByMultipleFaces) {
        setFaceDetected(true);
        setFaceValid(false);
        setStabilityProgress(0);
        setDetectionScore(0);
        setGuidanceMessage(MULTI_FACE_MESSAGE);
        resetDetectionStateV2();
        return;
      }

      if (!detection || processingRef.current) {
        const recentlyAccepted = now - detectionStateRef.current.lastAcceptedAt <= DETECTION_GRACE_MS;
        if (!recentlyAccepted) {
          setFaceDetected(false);
          setGuidanceMessage((detections || []).length > 0 ? 'Posicione o rosto dentro da área central.' : 'Aguardando rosto');
          resetDetectionStateV2();
        } else {
          setGuidanceMessage('Pequeno movimento detectado, mantendo tentativa');
        }
        return;
      }

      const box = detection.box;
      if (!box || box.width <= 0 || box.height <= 0 || Number.isNaN(box.x) || Number.isNaN(box.y)) {
        return;
      }

      setFaceDetected(true);
      setDetectionScore(Math.round(detection.score * 100));

      const geometry = getFaceGeometry(box, video.videoWidth, video.videoHeight);
      const isInsideCentralRegion = isFaceInsideCentralRegion(box, video.videoWidth, video.videoHeight);
      const isCentered = geometry.offsetX <= CENTER_TOLERANCE_X && geometry.offsetY <= CENTER_TOLERANCE_Y;
      const isBigEnough = geometry.faceAreaRatio >= MIN_FACE_AREA_RATIO;
      const qualityOk = detection.score >= LIVE_DETECTION_CONFIDENCE;
      const movementOk = !detectionStateRef.current.lastBox || isMovementTolerable(detectionStateRef.current.lastBox, box, video.videoWidth, video.videoHeight);
      const isValid = qualityOk && isInsideCentralRegion && isCentered && isBigEnough && movementOk;

      if (!isInsideCentralRegion || !isCentered) {
        setGuidanceMessage('Posicione o rosto dentro da área central.');
      } else if (!isBigEnough) {
        setGuidanceMessage('Rosto detectado. Aproxime-se da câmera.');
      } else if (!qualityOk) {
        setGuidanceMessage('Rosto detectado. Melhore a iluminação do ambiente.');
      } else if (pendingConfirmationRef.current) {
        setGuidanceMessage('Processando');
      } else {
        setGuidanceMessage('Rosto detectado');
      }

      if (!isValid) {
        const recentlyAccepted = now - detectionStateRef.current.lastAcceptedAt <= DETECTION_GRACE_MS;
        if (!recentlyAccepted) {
          setFaceValid(false);
          setStabilityProgress(0);
          detectionStateRef.current.stableSince = null;
        }
        return;
      }

      detectionStateRef.current.lastAcceptedAt = now;
      detectionStateRef.current.lastBox = box;
      if (!detectionStateRef.current.stableSince) {
        detectionStateRef.current.stableSince = now;
      }

      lastValidDetectionRef.current = now;
      setFaceValid(true);

      const stableTime = now - detectionStateRef.current.stableSince;
      const progress = Math.min(100, (stableTime / LIVE_STABILITY_TIME) * 100);
      setStabilityProgress(progress);

      if (stableTime >= LIVE_STABILITY_TIME) {
        scheduleAutoCaptureV2();
      }
    } catch (error) {
      console.warn('Erro na detecção em tempo real:', error?.message || error);
    } finally {
      detectionInFlightRef.current = false;
    }
  }, [
    isMovementTolerable,
    isProcessingEmbedding,
    loading,
    resetDetectionStateV2,
    scheduleAutoCaptureV2
  ]);

  const searchByFaceV2 = useCallback(async () => {
    if (loading || isProcessingEmbedding) return;
    setNotFoundMessage(null);
    setAutoCaptureEnabled(true);
    setSimilarityMessage('Captura manual em andamento');
    await captureAndIdentifyV2(false);
  }, [captureAndIdentifyV2, isProcessingEmbedding, loading]);

  const detectFaceInRealTime = async () => {
    // LOCK: NÃO executar se estiver processando
    if (processingRef.current || loading || isProcessingEmbedding) return;
    
    // Validar vídeo
    if (!isVideoReady()) {
      setGuidanceMessage('Aguardando câmera...');
      return;
    }
    
    const video = webcamRef.current.video;
    
    try {
      // Detecção LEVE (inputSize: 128) - muito rápida
      const detection = await faceapi.detectSingleFace(video, DETECTION_OPTIONS);
      
      if (detection && !processingRef.current) {
        // Validar box da detecção (evitar erro de caixa inválida)
        const box = detection.box;
        if (!box || box.width <= 0 || box.height <= 0 || isNaN(box.x) || isNaN(box.y)) {
          console.warn('Detecção com caixa inválida, ignorando frame');
          return;
        }
        
        const score = detection.score;
        setDetectionScore(Math.round(score * 100));
        setFaceDetected(true);
        
        const videoWidth = video.videoWidth;
        const videoHeight = video.videoHeight;
        
        // Verificar centralização
        const centerX = box.x + box.width / 2;
        const centerY = box.y + box.height / 2;
        const isXCentered = Math.abs(centerX - videoWidth / 2) < videoWidth * 0.25;
        const isYCentered = Math.abs(centerY - videoHeight / 2) < videoHeight * 0.30;
        
        // Verificar tamanho mínimo
        const faceArea = box.width * box.height;
        const minArea = videoWidth * videoHeight * 0.03;
        const isBigEnough = faceArea > minArea;
        
        const isValid = score >= DETECTION_CONFIDENCE && isXCentered && isYCentered && isBigEnough;
        
        // Atualizar mensagem de orientação
        if (!isXCentered || !isYCentered) {
          setGuidanceMessage('Centralize o rosto na área marcada');
        } else if (!isBigEnough) {
          setGuidanceMessage('Aproxime-se da câmera');
        } else if (score < DETECTION_CONFIDENCE) {
          setGuidanceMessage('Melhore a iluminação do ambiente');
        } else {
          setGuidanceMessage('Mantenha o rosto estável');
        }
        
        if (isValid && !processingRef.current) {
          setFaceValid(true);
          
          // Controle de estabilidade
          if (!lastValidDetectionRef.current) {
            lastValidDetectionRef.current = Date.now();
          }
          
          const stableTime = Date.now() - lastValidDetectionRef.current;
          const progress = Math.min(100, (stableTime / STABILITY_TIME) * 100);
          setStabilityProgress(progress);
          
          // Captura automática
          if (stableTime >= STABILITY_TIME && !stabilityTimerRef.current && !processingRef.current && autoCaptureEnabled && autoAttemptsRef.current < MAX_AUTO_ATTEMPTS) {
            stabilityTimerRef.current = setTimeout(() => {
              if (!processingRef.current && autoAttemptsRef.current < MAX_AUTO_ATTEMPTS) {
                autoAttemptsRef.current += 1;
                setAutoAttempts(autoAttemptsRef.current);
                captureAndIdentify(true);
              }
            }, 100);
          }
        } else {
          resetStability();
        }
      } else {
        setFaceDetected(false);
        setFaceValid(false);
        setDetectionScore(0);
        setGuidanceMessage('Posicione o rosto no centro da câmera');
        resetStability();
      }
    } catch (error) {
      // Tratar erros silenciosamente para não travar a tela
      console.warn('Erro na detecção (frame ignorado):', error.message);
    }
  };

  const resetStability = () => {
    setFaceValid(false);
    setStabilityProgress(0);
    lastValidDetectionRef.current = null;
    if (stabilityTimerRef.current) {
      clearTimeout(stabilityTimerRef.current);
      stabilityTimerRef.current = null;
    }
  };

  // ========================================
  // CAPTURA E IDENTIFICAÇÃO (OTIMIZADA)
  // ========================================
  
  const captureAndIdentify = async (isAutoCapture = false) => {
    // LOCK: Evitar múltiplas execuções simultâneas
    if (processingRef.current) {
      console.log('Identificação já em andamento - ignorando');
      return;
    }
    
    if (isProcessingEmbedding || !webcamRef.current) return;
    
    console.log(`Iniciando identificação (auto: ${isAutoCapture})`);
    processingRef.current = true;
    
    // Parar detecção antes de processar
    stopContinuousDetection();
    
    // Aguardar intervalo parar completamente
    await new Promise(resolve => setTimeout(resolve, 200));
    
    setIsProcessingEmbedding(true);
    setLoading(true);
    setLoadingStatus('Capturando...');
    
    try {
      // Capturar screenshot
      const imageSrc = webcamRef.current.getScreenshot();
      if (!imageSrc) {
        toast.error('Erro ao capturar imagem');
        resetAfterProcess(isAutoCapture);
        return;
      }
      
      setCapturedPhoto(imageSrc);
      setLoadingStatus('Gerando vetor facial...');
      
      const img = new Image();
      img.crossOrigin = 'anonymous';
      
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = imageSrc;
      });
      
      // Usar opções otimizadas para embedding
      const detection = await faceapi
        .detectSingleFace(img, EMBEDDING_OPTIONS)
        .withFaceLandmarks()
        .withFaceDescriptor();
      
      if (!detection) {
        toast.error('Rosto não detectado na captura. Tente novamente.');
        resetAfterProcess(isAutoCapture);
        return;
      }
      
      // Buscar no cache (OTIMIZADO)
      setLoadingStatus('Identificando...');
      let bestMatch = { employee: null, score: 0 };
      
      // Comparação otimizada - apenas com templates ativos
      for (const cached of facialTemplatesCache) {
        // Futuro: adicionar filtro por setor/empresa aqui
        // if (filterBySector && cached.sector !== currentSector) continue;
        
        try {
          const distance = faceapi.euclideanDistance(detection.descriptor, cached.descriptor);
          const similarity = 1 - distance;
          
          if (similarity > bestMatch.score) {
            bestMatch = { employee: cached.employee, score: similarity };
          }
        } catch (e) {
          console.warn('Erro ao comparar template:', e);
        }
      }
      
      // Verificar resultado
      if (bestMatch.score >= SIMILARITY_THRESHOLD && bestMatch.employee) {
        const percentMatch = Math.round(bestMatch.score * 100);
        toast.success(`${bestMatch.employee.full_name} identificado!`);
        setFacialMatch({ score: bestMatch.score, verified: true });
        setSelectedEmployee(bestMatch.employee);
        await fetchEmployeeHistory(bestMatch.employee.id);
        
        setLoadingStatus('');
        setLoading(false);
        setIsProcessingEmbedding(false);
        
        // Resetar contadores
        autoAttemptsRef.current = 0;
        setAutoAttempts(0);
        setAutoCaptureEnabled(true);
        
        await new Promise(resolve => setTimeout(resolve, 150));
        
        setShowWebcam(false);
        setStep('delivery');
      } else {
        const percentMatch = Math.round(bestMatch.score * 100);
        setNotFoundMessage({
          message: 'Colaborador não encontrado'
        });
        
        if (isAutoCapture && autoAttemptsRef.current >= MAX_AUTO_ATTEMPTS) {
          setAutoCaptureEnabled(false);
          toast.error('Não reconhecido. Use a captura manual ou selecione o colaborador.');
        } else {
          toast.error('Não reconhecido. Posicione-se novamente.');
        }
        
        resetAfterProcess(isAutoCapture);
      }
    } catch (error) {
      console.error('Erro na identificação:', error);
      toast.error('Erro ao processar. Tente novamente.');
      resetAfterProcess(isAutoCapture);
    } finally {
      setLoading(false);
      setLoadingStatus('');
      setIsProcessingEmbedding(false);
      processingRef.current = false;
    }
  };

  const resetAfterProcess = (wasAutoCapture = false) => {
    setIsProcessingEmbedding(false);
    resetStability();
    
    if (wasAutoCapture && autoAttemptsRef.current >= MAX_AUTO_ATTEMPTS) {
      console.log('Limite de tentativas automáticas atingido');
      setTimeout(() => {
        if (showWebcam) startContinuousDetection();
      }, 2000);
      return;
    }
    
    setTimeout(() => {
      if (showWebcam) startContinuousDetection();
    }, 1000);
  };

  // Função para identificar manualmente
  const searchByFace = async () => {
    if (loading || isProcessingEmbedding) return;
    setNotFoundMessage(null);
    autoAttemptsRef.current = 0;
    setAutoAttempts(0);
    setAutoCaptureEnabled(true);
    await captureAndIdentify(false);
  };

  const fetchEPIs = async () => {
    try {
      const response = await axios.get(`${API}/epis`, { headers: withNoCache(getAuthHeader()) });
      setEpis(response.data);
    } catch (error) {
      console.error('Erro ao buscar EPIs:', error);
    }
  };

  const fetchKits = async () => {
    try {
      const response = await axios.get(`${API}/kits`, { headers: withNoCache(getAuthHeader()) });
      setKits(response.data);
    } catch (error) {
      console.error('Erro ao buscar Kits:', error);
    }
  };

  const fetchAllEmployees = async () => {
    try {
      const response = await axios.get(`${API}/employees`, { headers: withNoCache(getAuthHeader()) });
      setAllEmployees(response.data);
    } catch (error) {
      console.error('Erro ao buscar colaboradores:', error);
    }
  };

  const fetchCounterAttendants = async () => {
    try {
      const response = await axios.get(`${API}/counter-attendants/active`, { headers: withNoCache(getAuthHeader()) });
      setCounterAttendants(response.data || []);
    } catch (error) {
      console.error('Erro ao buscar atendentes do balcão:', error);
      setCounterAttendants([]);
      toast.error('Erro ao carregar atendentes do balcão');
    }
  };

  const fetchEmployeeHistory = async (employeeId) => {
    try {
      const response = await axios.get(`${API}/deliveries?employee_id=${employeeId}`, {
        headers: withNoCache(getAuthHeader())
      });
      setEmployeeHistory(response.data);
      
      const itemsMap = {};
      response.data.forEach(delivery => {
        if (delivery.items) {
          delivery.items.forEach(item => {
            const key = item.epi_id || item.name;
            const name = item.epi_name || item.name;
            if (!itemsMap[key]) {
              itemsMap[key] = { name, quantity: 0, deliveries: [] };
            }
            if (delivery.is_return) {
              itemsMap[key].quantity -= item.quantity;
            } else {
              itemsMap[key].quantity += item.quantity;
              itemsMap[key].deliveries.push(delivery.created_at);
            }
          });
        }
      });
      
      const currentItems = Object.entries(itemsMap)
        .filter(([_, v]) => v.quantity > 0)
        .map(([id, v]) => ({ id, ...v }));
      setEmployeeCurrentItems(currentItems);
    } catch (error) {
      console.error('Erro ao buscar histórico:', error);
    }
  };

  const inferEmployeeSizeField = (epi) => {
    const category = `${epi?.category || epi?.type_category || ''}`.toLowerCase();
    const name = `${epi?.name || ''}`.toLowerCase();
    if (['botina', 'bota', 'sapato', 'calcado', 'calçado'].some(token => name.includes(token)) || category.includes('pés') || category.includes('pes')) {
      return 'tamanho_calcado';
    }
    if (name.includes('luva') || category.includes('mãos') || category.includes('maos')) {
      return 'tamanho_luva';
    }
    if (['calça', 'calca', 'bermuda'].some(token => name.includes(token)) || category.includes('pernas')) {
      return 'tamanho_calca';
    }
    if (['camisa', 'camiseta', 'jaqueta', 'jaleco', 'avental'].some(token => name.includes(token)) || category.includes('corpo')) {
      return 'tamanho_camisa';
    }
    return null;
  };

  const resolveVariationForEmployee = (epi) => {
    const variations = epi?.variations || [];
    if (!variations.length) return null;

    const sizeField = inferEmployeeSizeField(epi);
    const desiredSize = normalizeSize(sizeField ? selectedEmployee?.[sizeField] : '');
    const candidates = getAvailableVariations(epi);

    if (desiredSize) {
      const exact = candidates.find((variation) => normalizeSize(variation.size || variation.tamanho) === desiredSize);
      if (exact) return exact;
      return null;
    }

    return candidates[0] || null;
  };

  const mapSuggestionItemToSelectedItem = (item, kitName, kitId = '') => ({
    epi_id: item.variation?.epi_id || item.epi_id || '',
    epi_base_id: item.epi_base_id || item.epi_id,
    epi_group_key: item.epi_group_key || item.epi_base_key || '',
    epi_variation_id: item.requires_variation_selection === false ? (item.epi_variation_id || item.variation?.id || '') : '',
    kit_id: kitId,
    name: item.name,
    quantity: item.quantity || 1,
    size: item.variation?.size || item.variation?.tamanho || '',
    batch: item.variation?.batch || item.variation?.lote || '',
    qr_code: item.variation?.qr_code || '',
    ca_number: item.variation?.ca_number || item.variation?.ca || '',
    available_stock: item.variation?.current_stock ?? item.variation?.stock ?? item.current_stock ?? 0,
    from_kit: kitName || item.kit_name || '',
    available_variations: item.available_variations || [],
    suggested_variation_id: item.suggested_variation_id || item.variation?.id || '',
    requires_variation_selection: item.requires_variation_selection !== false
  });

  const fetchDeliverySuggestions = async (employeeId, kitId = '') => {
    try {
      setSuggestionLoading(true);
      const query = kitId ? `?kit_id=${kitId}` : '';
      const response = await axios.get(`${API}/employees/${employeeId}/delivery-suggestions${query}`, {
        headers: withNoCache(getAuthHeader())
      });
      setDeliverySuggestion(response.data);

      const availableItems = (response.data.items || []).filter((item) => item.status === 'available');
      const unavailableItems = (response.data.items || []).filter((item) => item.status !== 'available');

      if (kitId || (response.data.kit_id && selectedItems.length === 0)) {
        setSelectedItems(availableItems.map((item) => mapSuggestionItemToSelectedItem(item, response.data.kit_name, response.data.kit_id)));
      }

      unavailableItems.forEach((item) => {
        toast.warning(item.message || `Sem estoque para ${item.name}`);
      });
    } catch (error) {
      console.error('Erro ao buscar sugestões de entrega:', error);
      setDeliverySuggestion(null);
    } finally {
      setSuggestionLoading(false);
    }
  };

  const handleQRScan = async (qrCode) => {
    if (qrScannerRef.current) {
      try {
        await qrScannerRef.current.stop();
        qrScannerRef.current.clear();
      } catch (e) {
        console.log('Error stopping scanner:', e);
      }
      qrScannerRef.current = null;
    }
    setShowQRScanner(false);
    
    const epi = epis.find(e => e.qr_code === qrCode);
    if (epi) {
      addItem(epi);
      toast.success(`EPI ${epi.name} adicionado`);
    } else {
      toast.error('QR Code não corresponde a nenhum EPI cadastrado');
    }
  };

  const startQRScanner = async () => {
    setShowQRScanner(true);
    await new Promise(resolve => setTimeout(resolve, 100));
    
    try {
      const html5Qrcode = new Html5Qrcode('qr-reader');
      qrScannerRef.current = html5Qrcode;
      
      await html5Qrcode.start(
        { facingMode: "environment" },
        {
          fps: 10,
          qrbox: { width: 250, height: 250 },
          aspectRatio: 1.0
        },
        (decodedText) => {
          handleQRScan(decodedText);
        },
        (errorMessage) => {}
      );
    } catch (err) {
      console.error('Erro ao iniciar scanner:', err);
      toast.error('Erro ao acessar câmera para QR Code');
      setShowQRScanner(false);
    }
  };
  
  const stopQRScanner = async () => {
    if (qrScannerRef.current) {
      try {
        await qrScannerRef.current.stop();
        qrScannerRef.current.clear();
      } catch (e) {
        console.log('Error stopping scanner:', e);
      }
      qrScannerRef.current = null;
    }
    setShowQRScanner(false);
  };

  const addItem = (epi) => {
    const selectionIssue = getEpiSelectionIssue(epi, deliveryType);
    if (selectionIssue) {
      toast.error(selectionIssue);
      return;
    }

    if (selectedItems.find(item => item.epi_id === epi.id || item.epi_base_id === epi.id)) {
      toast.info(`${epi.name} já está selecionado.`);
      return;
    }

    const availableVariations = getAvailableVariations(epi);
    const variation = resolveVariationForEmployee(epi);
    const requiresVariationSelection = availableVariations.length > 0 && !variation;
    const availableStock = Number(variation?.current_stock ?? epi.current_stock ?? 0);

    setSelectedItems((currentItems) => [...currentItems, {
      epi_id: variation?.epi_id || epi.id,
      epi_base_id: epi.id,
      epi_group_key: epi.epi_group_key || '',
      epi_variation_id: variation?.id || '',
      name: epi.name,
      quantity: 1,
      size: variation?.size || variation?.tamanho || epi.size || '',
      batch: variation?.batch || variation?.lote || epi.batch || '',
      qr_code: variation?.qr_code || epi.qr_code || '',
      ca_number: variation?.ca_number || variation?.ca || epi.ca_number || '',
      available_stock: requiresVariationSelection ? 0 : availableStock,
      available_variations: availableVariations,
      suggested_variation_id: variation?.id || '',
      requires_variation_selection: requiresVariationSelection
    }]);

    if (requiresVariationSelection) {
      toast.info(`Selecione o tamanho/variação de ${epi.name}.`);
    }
  };

  const addKit = async (kit) => {
    if (!selectedEmployee) {
      toast.error('Identifique um colaborador antes de carregar o kit');
      return;
    }
    await fetchDeliverySuggestions(selectedEmployee.id, kit.id);
    toast.success(`Kit "${kit.name}" carregado. Selecione as variações disponíveis.`);
  };

  const removeItem = (index) => {
    setSelectedItems(selectedItems.filter((_, i) => i !== index));
  };

  const applyVariationToItem = (index, variationId) => {
    setSelectedItems((currentItems) => currentItems.map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      const variation = (item.available_variations || []).find((entry) => entry.id === variationId);
      return {
        ...item,
        epi_id: variation?.epi_id || item.epi_id,
        epi_variation_id: variationId,
        size: variation?.size || variation?.tamanho || '',
        batch: variation?.batch || variation?.lote || '',
        qr_code: variation?.qr_code || '',
        ca_number: variation?.ca_number || variation?.ca || '',
        brand: variation?.brand || variation?.marca || '',
        model: variation?.model || variation?.modelo || '',
        supplier_name: variation?.supplier_name || variation?.fornecedor || '',
        validity_date: variation?.validity_date || variation?.ca_validity || variation?.validade_ca || '',
        available_stock: variation?.current_stock ?? variation?.stock ?? item.available_stock ?? 0
      };
    }));
  };

  const updateItemQuantity = (index, value) => {
    const parsed = parseInt(value, 10);
    const quantity = Number.isNaN(parsed) ? 1 : Math.max(1, parsed);
    setSelectedItems((currentItems) => currentItems.map((item, itemIndex) => (
      itemIndex === index ? { ...item, quantity } : item
    )));
  };

  const getSelectedItemBlockingReason = (item) => {
    if (item.requires_variation_selection && !item.epi_variation_id) {
      return `Selecione a variação de ${item.name}.`;
    }
    if (!Number.isFinite(Number(item.quantity)) || Number(item.quantity) < 1) {
      return `Informe uma quantidade válida para ${item.name}.`;
    }
    return getItemStockIssue(item, deliveryType);
  };

  const firstBlockingItemReason = selectedItems.map(getSelectedItemBlockingReason).find(Boolean);
  const selectedCounterAttendant = counterAttendants.find((attendant) => attendant.id === selectedAttendantId);
  const counterAttendantBlockingReason = isCounterUser && !selectedAttendantId
    ? 'Selecione o atendente responsável pela entrega.'
    : '';
  const canConfirmDelivery = Boolean(
    !loading &&
    facialMatch?.verified &&
    selectedItems.length > 0 &&
    !counterAttendantBlockingReason &&
    !firstBlockingItemReason
  );
  const canShowDeliveryPanel = Boolean(selectedEmployee && (step === 'delivery' || facialMatch?.verified));

  // Função para mostrar termo de consentimento antes de confirmar
  // Função para confirmar entrega - agora sem termo (consentimento é no cadastro da biometria)
  const handleConfirmDelivery = async () => {
    if (selectedItems.length === 0) {
      toast.error('Adicione pelo menos um item');
      return;
    }
    if (!facialMatch?.verified) {
      toast.error('Verificação facial obrigatória');
      return;
    }
    if (counterAttendantBlockingReason) {
      toast.error(counterAttendantBlockingReason);
      return;
    }
    // Chamar diretamente a entrega (consentimento já foi dado no cadastro da biometria)
    if (firstBlockingItemReason) {
      toast.error(firstBlockingItemReason);
      return;
    }
    const missingVariation = selectedItems.find((item) => item.requires_variation_selection && !item.epi_variation_id);
    if (missingVariation) {
      toast.error(`Selecione a variação de ${missingVariation.name} antes de concluir.`);
      return;
    }
    const invalidQuantity = selectedItems.find((item) => !Number.isFinite(Number(item.quantity)) || Number(item.quantity) < 1);
    if (invalidQuantity) {
      toast.error(`Informe uma quantidade valida para ${invalidQuantity.name}.`);
      return;
    }
    const insufficientStock = selectedItems.find((item) => (
      deliveryType !== 'return' &&
      item.available_stock !== undefined &&
      item.available_stock !== null &&
      Number(item.quantity || 1) > Number(item.available_stock)
    ));
    if (insufficientStock) {
      toast.error(getItemStockIssue(insufficientStock, deliveryType) || INSUFFICIENT_STOCK_MESSAGE);
      return;
    }
    await completeDelivery();
  };

  const completeDelivery = async () => {
    setLoading(true);
    
    try {
      let photoPath = null;
      if (capturedPhoto) {
        try {
          const photoRes = await axios.post(
            `${API}/deliveries/save-photo`,
            new URLSearchParams({
              employee_id: selectedEmployee.id,
              photo_data: capturedPhoto
            }),
            { headers: { ...getAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' } }
          );
          photoPath = photoRes.data.photo_path;
        } catch (e) {
          console.error('Erro ao salvar foto:', e);
        }
      }

      await axios.post(
        `${API}/deliveries`,
        {
          employee_id: selectedEmployee.id,
          delivery_type: deliveryType,
          is_return: deliveryType === 'return',
          facial_match_score: facialMatch?.score,
          facial_photo_path: photoPath,
          facial_validation_status: facialMatch?.status || 'approved',
          facial_validation_message: facialMatch?.message || similarityMessage,
          facial_liveness_status: facialMatch?.livenessStatus || 'not_required',
          facial_second_capture_used: Boolean(facialMatch?.secondCaptureUsed),
          attendant_id: isCounterUser ? selectedAttendantId : undefined,
          items: selectedItems.map((item) => ({
            ...item,
            quantity: Math.max(1, parseInt(item.quantity, 10) || 1)
          }))
        },
        { headers: getAuthHeader() }
      );

      toast.success(
        deliveryType === 'delivery' 
          ? 'Entrega registrada com sucesso!' 
          : 'Devolução registrada com sucesso!'
      );
      
      resetForm();
    } catch (error) {
      console.error('Erro ao registrar:', error);
      const courseBlock = buildCourseBlockModal(error, selectedItems);
      if (courseBlock) {
        setCourseBlockModal(courseBlock);
      } else {
        toast.error(getDeliveryErrorMessage(error));
      }
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    stopContinuousDetection();
    resetDetectionStateV2();
    
    setStep('facial');
    setSelectedEmployee(null);
    setFacialMatch(null);
    setSelectedItems([]);
    setDeliverySuggestion(null);
    setSelectedAttendantId('');
    setEmployeeHistory([]);
    setEmployeeCurrentItems([]);
    setCapturedPhoto(null);
    setNotFoundMessage(null);
    setCourseBlockModal(null);
    setShowWebcam(true);
    setCameraFacingMode('user');
    setSimilarityScore(0);
    setSimilarityMessage('Aguardando validação facial');
    pendingConfirmationRef.current = null;
    autoAttemptsRef.current = 0;
    setAutoAttempts(0);
    setAutoCaptureEnabled(true);
    fetchEPIs();
    fetchKits();
    fetchEmployees();
  };

  return (
    <DashboardLayout>
      {courseBlockModal && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/80 px-4 py-6"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="course-block-title"
          aria-describedby="course-block-message"
          data-testid="course-block-modal"
        >
          <div className="w-full max-w-2xl rounded-lg border-2 border-red-500 bg-white shadow-2xl">
            <div className="border-b border-red-200 bg-red-50 px-6 py-5 text-center">
              <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-red-100">
                <AlertTriangle className="h-8 w-8 text-red-700" aria-hidden="true" />
              </div>
              <h2 id="course-block-title" className="text-3xl font-bold text-red-800">
                {courseBlockModal.title}
              </h2>
            </div>

            <div className="max-h-[70vh] overflow-y-auto px-6 py-5">
              <p id="course-block-message" className="text-xl font-semibold leading-relaxed text-slate-900">
                {courseBlockModal.message}
              </p>

              <div className="mt-5 space-y-4">
                {courseBlockModal.items.map((item, index) => (
                  <div key={`${item.epi || item.course || index}`} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                    {item.kit && (
                      <div className="mb-3">
                        <p className="text-sm font-semibold uppercase text-slate-500">Kit</p>
                        <p className="text-lg font-bold text-slate-900">{item.kit}</p>
                      </div>
                    )}
                    {item.epi && (
                      <div className="mb-3">
                        <p className="text-sm font-semibold uppercase text-slate-500">
                          {courseBlockModal.title.includes('KIT') ? 'Item bloqueado' : 'EPI'}
                        </p>
                        <p className="text-lg font-bold text-slate-900">{item.epi}</p>
                      </div>
                    )}
                    {item.course && (
                      <div className="mb-3">
                        <p className="text-sm font-semibold uppercase text-slate-500">Curso obrigatório</p>
                        <p className="text-lg font-bold text-slate-900">{item.course}</p>
                      </div>
                    )}
                    {item.status && (
                      <div className="mb-3">
                        <p className="text-sm font-semibold uppercase text-slate-500">Situação</p>
                        <p className="text-lg font-bold text-red-700">{item.status}</p>
                      </div>
                    )}
                    {item.expirationDate && (
                      <div className="mb-3">
                        <p className="text-sm font-semibold uppercase text-slate-500">Validade</p>
                        <p className="text-lg font-bold text-slate-900">{formatDateBR(item.expirationDate)}</p>
                      </div>
                    )}
                    {item.reason && (
                      <div>
                        <p className="text-sm font-semibold uppercase text-slate-500">Motivo do bloqueio</p>
                        <p className="text-base font-medium text-slate-800">{item.reason}</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <p className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-base font-semibold text-red-800">
                {courseBlockModal.closingMessage}
              </p>
            </div>

            <div className="border-t border-slate-200 px-6 py-4">
              <Button
                type="button"
                onClick={() => setCourseBlockModal(null)}
                className="w-full bg-red-600 py-6 text-lg font-bold text-white hover:bg-red-700"
                data-testid="course-block-ok"
              >
                OK
              </Button>
            </div>
          </div>
        </div>
      )}
      <div className="space-y-6" data-testid="entrega-epi-page">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Entrega de EPI</h1>
          <p className="text-slate-600 mt-1">Registre entregas e devoluções via reconhecimento facial</p>
        </div>

        {/* ETAPA 1: RECONHECIMENTO FACIAL OBRIGATÓRIO */}
        <div 
          className="bg-white border border-slate-200 rounded-lg shadow-sm p-6"
          style={{ display: step === 'facial' ? 'block' : 'none' }}
        >
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
            <div className="flex items-start gap-3">
              <ScanFace className="w-6 h-6 text-blue-600 flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="font-medium text-blue-900">Identificação Obrigatória</h3>
                <p className="text-sm text-blue-700 mt-1">
                  Posicione o rosto do colaborador na câmera para identificação biométrica. 
                  A entrega só pode ser realizada após confirmação facial.
                </p>
              </div>
            </div>
          </div>
          
          {/* Dicas de iluminação */}
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
            <div className="flex items-start gap-2">
              <Info className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-amber-800">
                <p className="font-medium">Dicas para melhor reconhecimento:</p>
                <ul className="list-disc list-inside mt-1 space-y-0.5 text-amber-700">
                  <li>Use o reconhecimento em local bem iluminado</li>
                  <li>Mantenha o rosto centralizado e estável</li>
                  <li>Se a identificação demorar, tente a captura manual</li>
                </ul>
              </div>
            </div>
          </div>
            
          {/* Status de carregamento */}
          <div className={loadingStatus ? 'flex items-center justify-center gap-3 py-3 px-4 bg-slate-100 rounded-lg mb-4' : 'hidden'}>
            <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
            <span className="text-sm text-slate-700">{loadingStatus}</span>
          </div>
          
          {/* Info de templates carregados */}
          <div className={templatesLoaded && facialTemplatesCache.length > 0 ? 'flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 px-4 py-2 rounded-lg mb-4' : 'hidden'}>
            <CheckCircle2 className="w-4 h-4" />
            <span>{facialTemplatesCache.length} colaborador(es) com biometria cadastrada</span>
          </div>
          
          <div className={templatesLoaded && facialTemplatesCache.length === 0 ? 'p-4 bg-amber-50 border border-amber-200 rounded-lg mb-4' : 'hidden'}>
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="font-medium text-amber-800">Nenhum colaborador com biometria cadastrada</p>
                <p className="text-sm text-amber-700 mt-1">
                  Para usar o reconhecimento facial, é necessário cadastrar o template facial na ficha do colaborador 
                  (aba "Biometria Facial").
                </p>
                <Button
                  onClick={() => navigate('/colaboradores')}
                  className="mt-3 bg-amber-600 hover:bg-amber-700"
                  size="sm"
                >
                  <UserPlus className="w-4 h-4 mr-2" />
                  Ir para Colaboradores
                </Button>
              </div>
            </div>
          </div>

          {/* Loading state */}
          <div className={!modelsLoaded || !templatesLoaded ? 'flex flex-col items-center justify-center py-12 px-6' : 'hidden'}>
            <div className="w-full max-w-md">
              <div className="flex justify-center mb-6">
                <div className="relative">
                  <div className="animate-spin rounded-full h-16 w-16 border-4 border-blue-200"></div>
                  <div className="absolute inset-0 animate-spin rounded-full h-16 w-16 border-4 border-transparent border-t-blue-500"></div>
                </div>
              </div>
              
              <p className="text-slate-700 text-center font-medium text-lg mb-4">
                {loadingStatus || 'Preparando sistema...'}
              </p>
              
              <div className="w-full bg-slate-200 rounded-full h-3 mb-2">
                <div 
                  className="bg-blue-500 h-3 rounded-full transition-all duration-500"
                  style={{ width: `${loadingProgress}%` }}
                ></div>
              </div>
              <p className="text-slate-500 text-center text-sm">
                {loadingProgress}% concluído
              </p>
            </div>
          </div>
          
          {/* Webcam section */}
          <div className={modelsLoaded && templatesLoaded ? 'max-w-xl mx-auto' : 'hidden'}>
            <div className={templateCount > 0 ? 'flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 px-4 py-2 rounded-lg mb-4' : 'hidden'}>
              <ScanFace className="w-4 h-4" />
              <span>{templateCount} colaborador(es) com biometria cadastrada</span>
            </div>
            
            <div className={showWebcam ? 'block' : 'hidden'}>
              {/* Status de detecção em tempo real */}
              <div className="mb-4 p-3 rounded-lg bg-slate-50 border border-slate-200">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-slate-700">Status da Detecção</span>
                  <span className={`text-sm font-bold ${faceValid ? 'text-emerald-600' : faceDetected ? 'text-amber-600' : 'text-slate-400'}`}>
                    {faceValid ? 'Rosto Válido' : faceDetected ? 'Ajuste posição' : 'Aguardando rosto'}
                  </span>
                </div>
                
                {/* Mensagem de orientação */}
                <p className="text-xs text-slate-600 mb-2">{guidanceMessage}</p>
                
                {/* Barra de estabilidade */}
                <div className={faceValid ? 'space-y-1' : 'hidden'}>
                  <div className="flex justify-between text-xs text-slate-500">
                    <span>Estabilidade</span>
                    <span>{Math.round(stabilityProgress)}%</span>
                  </div>
                  <div className="w-full bg-slate-200 rounded-full h-2">
                    <div 
                      className="bg-emerald-500 h-2 rounded-full transition-all duration-200"
                      style={{ width: `${stabilityProgress}%` }}
                    ></div>
                  </div>
                  <p className={stabilityProgress >= 100 ? 'text-xs text-emerald-600 font-medium animate-pulse' : 'hidden'}>
                    Capturando automaticamente...
                  </p>
                </div>
                
                {/* Indicador de confiança */}
                <div className={faceDetected ? 'mt-2 text-xs text-slate-500' : 'hidden'}>
                  Confiança: {detectionScore}% {detectionScore >= 65 ? '(OK)' : '(mova para frente)'}
                </div>
              </div>
                
              {/* Webcam Container - Otimizado para 640x480 */}
              <div 
                className="relative mx-auto bg-slate-900 rounded-xl overflow-hidden"
                style={{ 
                  maxWidth: '640px',
                  width: '100%',
                  aspectRatio: '4/3'
                }}
              >
                <Webcam
                  ref={webcamRef}
                  audio={false}
                  screenshotFormat="image/jpeg"
                  screenshotQuality={0.82}
                  forceScreenshotSourceSize={true}
                  className={`absolute inset-0 w-full h-full object-cover rounded-lg border-4 transition-colors duration-300 ${
                    faceValid ? 'border-emerald-400' : faceDetected ? 'border-amber-400' : 'border-blue-300'
                  }`}
                  videoConstraints={{
                    facingMode: { ideal: cameraFacingMode },
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    frameRate: { ideal: 18, max: 24 }
                  }}
                  mirrored={cameraFacingMode === 'user'}
                />
                
                {/* Guia de posicionamento */}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className={`w-24 h-32 sm:w-32 sm:h-44 md:w-40 md:h-52 border-4 border-dashed rounded-3xl transition-colors duration-300 ${
                    faceValid ? 'border-emerald-400 opacity-90' : faceDetected ? 'border-amber-400 opacity-80' : 'border-blue-400 opacity-60'
                  }`}>
                    <div className="absolute -top-1 -left-1 w-4 h-4 sm:w-5 sm:h-5 border-t-4 border-l-4 rounded-tl-lg border-current"></div>
                    <div className="absolute -top-1 -right-1 w-4 h-4 sm:w-5 sm:h-5 border-t-4 border-r-4 rounded-tr-lg border-current"></div>
                    <div className="absolute -bottom-1 -left-1 w-4 h-4 sm:w-5 sm:h-5 border-b-4 border-l-4 rounded-bl-lg border-current"></div>
                    <div className="absolute -bottom-1 -right-1 w-4 h-4 sm:w-5 sm:h-5 border-b-4 border-r-4 rounded-br-lg border-current"></div>
                  </div>
                </div>
                
                {/* Overlay de loading */}
                <div 
                  className="absolute inset-0 bg-black/70 flex items-center justify-center"
                  style={{ display: loading && loadingStatus ? 'flex' : 'none' }}
                >
                  <div className="bg-white px-6 py-4 rounded-xl flex flex-col items-center gap-3 shadow-lg">
                    <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
                    <span className="font-medium text-slate-700">{loadingStatus}</span>
                  </div>
                </div>
              </div>

              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1"
                  onClick={() => setCameraFacingMode((currentMode) => currentMode === 'user' ? 'environment' : 'user')}
                >
                  {cameraFacingMode === 'user' ? 'Usar Câmera Traseira' : 'Usar Câmera Frontal'}
                </Button>
                <div className="flex-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                  Backend facial: InsightFace/API
                  <span className="ml-2 font-medium text-slate-800">Detector local: {runtimeBackend}</span>
                </div>
              </div>
                  
              <p className={`text-center text-sm mt-3 mb-4 ${faceValid ? 'text-emerald-600 font-medium' : 'text-slate-500'}`}>
                {faceValid 
                  ? 'Mantenha a posição para captura automática' 
                  : guidanceMessage}
              </p>
              
              {/* Mensagem de não encontrado */}
              <div className={notFoundMessage ? 'mb-4 p-4 bg-red-50 border border-red-200 rounded-lg' : 'hidden'}>
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="font-medium text-red-800">{notFoundMessage?.message}</p>
                    <Button
                      onClick={() => navigate('/colaboradores')}
                      className="mt-3 bg-red-600 hover:bg-red-700"
                      size="sm"
                    >
                      <UserPlus className="w-4 h-4 mr-2" />
                      Cadastrar Novo Colaborador
                    </Button>
                  </div>
                </div>
              </div>
              
              {/* Botão de identificação manual */}
              <button
                onClick={searchByFaceV2}
                disabled={loading || !modelsLoaded}
                className={`w-full font-medium rounded-lg px-4 py-4 flex items-center justify-center gap-2 text-lg transition-all duration-300 ${
                  loading 
                    ? 'bg-slate-400 text-white cursor-not-allowed'
                    : faceValid 
                      ? 'bg-emerald-500 hover:bg-emerald-600 text-white shadow-lg shadow-emerald-200' 
                      : faceDetected 
                        ? 'bg-amber-500 hover:bg-amber-600 text-white'
                        : 'bg-blue-400 hover:bg-blue-500 text-white opacity-80'
                }`}
                data-testid="facial-identify-button"
              >
                <span className={loading ? 'flex items-center gap-2' : 'hidden'}>
                  <Loader2 className="w-6 h-6 animate-spin" />
                  {loadingStatus || 'Identificando...'}
                </span>
                <span className={!loading && faceValid ? 'flex items-center gap-2' : 'hidden'}>
                  <CheckCircle2 className="w-6 h-6" />
                  Capturar Agora (ou aguarde)
                </span>
                <span className={!loading && !faceValid && faceDetected ? 'flex items-center gap-2' : 'hidden'}>
                  <ScanFace className="w-6 h-6" />
                  Ajuste a Posição
                </span>
                <span className={!loading && !faceValid && !faceDetected ? 'flex items-center gap-2' : 'hidden'}>
                  <ScanFace className="w-6 h-6" />
                  Aguardando Rosto...
                </span>
              </button>
            </div>
          </div>
        </div>

        <div 
          className="mt-6 p-4 bg-amber-50 border border-amber-200 rounded-lg"
          style={{ display: step === 'facial' ? 'block' : 'none' }}
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-amber-800 flex-1">
              <p className="font-medium">Colaborador não reconhecido?</p>
              <p className="mb-3">Se o colaborador nao for identificado, uma nova captura facial sera exigida.</p>
              <div className="rounded border border-amber-300 bg-white p-3 text-sm">
                Base operacional: {allEmployees.length} colaborador(es). Este fluxo nao permite selecao manual, cracha ou QR Code para validar o colaborador.
              </div>
            </div>
          </div>
        </div>

        {/* ETAPA 2: ENTREGA/DEVOLUÇÃO */}
        <div 
          className="space-y-6"
          style={{ display: canShowDeliveryPanel ? 'block' : 'none' }}
        >
          {/* Info do Colaborador */}
          <div className="bg-white border border-slate-200 rounded-lg shadow-sm p-6">
            <div className="flex items-center gap-4 mb-4">
              <div className="w-20 h-20 rounded-full overflow-hidden border-4 border-emerald-200 shadow-md flex-shrink-0">
                {(capturedPhoto || selectedEmployee?.photo_path) ? (
                  <img 
                    src={capturedPhoto || getUploadUrl(selectedEmployee.photo_path)}
                    alt={selectedEmployee?.full_name || ''}
                    className="w-full h-full object-cover"
                    onError={(e) => { e.target.style.display = 'none'; }}
                  />
                ) : (
                  <div className="w-full h-full bg-emerald-100 flex items-center justify-center">
                    <User className="w-10 h-10 text-emerald-600" />
                  </div>
                )}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="font-bold text-xl text-slate-900">{selectedEmployee?.full_name || ''}</p>
                  <span className="px-2 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
                    Verificado
                  </span>
                </div>
                <p className="text-sm text-slate-600">Matrícula: {selectedEmployee?.registration_number || 'N/A'}</p>
                <p className="text-sm text-slate-600">Setor: {selectedEmployee?.department || 'N/A'}</p>
              </div>
              <button
                onClick={() => setShowHistoryDialog(true)}
                className="bg-slate-200 hover:bg-slate-300 text-slate-700 font-medium rounded-md px-4 py-2 flex items-center gap-2"
              >
                <History className="w-4 h-4" />
                Histórico
              </button>
            </div>

            {(selectedEmployee?.biometric_status === 'missing' || selectedEmployee?.biometric?.status === 'missing') && (
              <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium text-red-800">Colaborador sem biometria cadastrada.</p>
                      <p className="text-sm text-red-700">Cadastre a biometria antes de depender da identificacao facial automatica.</p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => navigate(`/colaboradores/${selectedEmployee.id}`)}
                    className="border-red-300 text-red-700 hover:bg-red-100"
                  >
                    <UserPlus className="w-4 h-4 mr-2" />
                    Cadastrar biometria agora
                  </Button>
                </div>
              </div>
            )}

            {/* EPIs em uso */}
            <div className={employeeCurrentItems.length > 0 ? 'p-4 bg-amber-50 border border-amber-200 rounded-lg' : 'hidden'}>
              <h3 className="font-medium text-amber-800 mb-3 flex items-center gap-2">
                <Package className="w-5 h-5" />
                EPIs em Uso Atualmente
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {employeeCurrentItems.map((item, idx) => (
                  <div key={item.id || `item-${item.name}-${idx}`} className="flex items-center justify-between p-2 bg-white rounded border border-amber-200">
                    <span className="text-sm font-medium text-slate-900">{item.name}</span>
                    <span className="text-sm text-amber-700">Qtd: {item.quantity}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Seleção de Itens */}
          <div className="bg-white border border-slate-200 rounded-lg shadow-sm p-6">
            <h2 className="text-lg font-bold text-slate-900 mb-4">Registrar Movimentação</h2>

            {isCounterUser && (
              <div className="mb-6 space-y-3">
                {!selectedAttendantId && (
                  <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-4">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="mt-0.5 h-6 w-6 flex-shrink-0 text-amber-700" />
                      <div>
                        <p className="text-lg font-bold text-amber-900">ATENDENTE NÃO SELECIONADO</p>
                        <p className="text-sm font-medium text-amber-800">
                          Selecione o atendente responsável pela entrega antes de confirmar.
                        </p>
                        <p className="text-sm text-amber-700">
                          A entrega será registrada no terminal balcao_jac e vinculada ao atendente escolhido.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                <div>
                  <label className="mb-2 flex items-center gap-2 text-sm font-bold text-slate-800">
                    <UserCheck className="h-4 w-4 text-emerald-600" />
                    ATENDENTE RESPONSÁVEL
                  </label>
                  <select
                    value={selectedAttendantId}
                    onChange={(event) => setSelectedAttendantId(event.target.value)}
                    className="flex h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                    data-testid="counter-attendant-select"
                  >
                    <option value="">
                      {counterAttendants.length > 0 ? 'Selecione o atendente...' : 'Nenhum atendente ativo cadastrado'}
                    </option>
                    {counterAttendants.map((attendant) => (
                      <option key={attendant.id} value={attendant.id}>
                        {attendant.full_name}
                      </option>
                    ))}
                  </select>
                  {selectedCounterAttendant && (
                    <p className="mt-2 rounded-md bg-emerald-50 px-3 py-2 text-sm font-bold text-emerald-800">
                      ATENDENTE DESTA ENTREGA: {selectedCounterAttendant.full_name}
                    </p>
                  )}
                </div>
              </div>
            )}

            <div className="flex gap-4 mb-6">
              <button
                onClick={() => setDeliveryType('delivery')}
                className={`flex-1 py-3 rounded-md font-medium transition-all ${
                  deliveryType === 'delivery'
                    ? 'bg-emerald-500 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
                data-testid="delivery-type-delivery"
              >
                Entrega
              </button>
              <button
                onClick={() => setDeliveryType('return')}
                className={`flex-1 py-3 rounded-md font-medium transition-all ${
                  deliveryType === 'return'
                    ? 'bg-blue-500 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
                data-testid="delivery-type-return"
              >
                Devolução
              </button>
            </div>

            {/* Seleção de Kit */}
            <div className="mb-4">
              {deliverySuggestion?.kit_name && (
                <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
                  <p className="font-medium">Kit sugerido automaticamente: {deliverySuggestion.kit_name}</p>
                  <p className="text-emerald-700">
                    {suggestionLoading ? 'Buscando variações e tamanhos...' : `${deliverySuggestion.items?.filter(item => item.status === 'available').length || 0} item(ns) prontos para entrega`}
                  </p>
                </div>
              )}
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Selecionar Kit:
              </label>
              <select
                onChange={(e) => {
                  const kit = kits.find(k => k.id === e.target.value);
                  if (kit) addKit(kit);
                  e.target.value = '';
                }}
                disabled={kits.length === 0}
                className="flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                data-testid="select-kit"
              >
                <option value="">{kits.length > 0 ? 'Selecione um Kit...' : 'Nenhum kit disponível para seleção'}</option>
                {kits.map((kit) => (
                  <option key={kit.id} value={kit.id}>
                    {kit.name} {kit.sector ? `(${kit.sector})` : ''} - {kit.items?.length || 0} itens
                  </option>
                ))}
              </select>
            </div>

            <button
              onClick={startQRScanner}
              className="w-full bg-slate-700 hover:bg-slate-800 text-white font-medium rounded-md px-4 py-3 flex items-center justify-center gap-2 mb-4"
              data-testid="start-qr-scanner"
              style={{ display: showQRScanner ? 'none' : 'flex' }}
            >
              <QrCode className="w-5 h-5" />
              Escanear QR Code
            </button>

            {/* QR Scanner Container */}
            <div 
              className="mb-4"
              style={{ display: showQRScanner ? 'block' : 'none' }}
            >
              <div className="bg-slate-100 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium text-slate-700">Escaneando QR Code...</span>
                  <button
                    onClick={stopQRScanner}
                    className="text-slate-500 hover:text-slate-700 p-1"
                    data-testid="stop-qr-scanner"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <div 
                  id="qr-reader" 
                  className="mx-auto overflow-hidden rounded-lg"
                  style={{ maxWidth: '300px' }}
                ></div>
                <p className="text-xs text-slate-500 text-center mt-2">
                  Aponte a câmera para o QR Code do EPI
                </p>
              </div>
            </div>

            <div className="mb-4">
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Selecionar EPI:
              </label>
              <select
                onChange={(e) => {
                  const epi = epis.find(ep => ep.id === e.target.value);
                  if (epi) addItem(epi);
                  e.target.value = '';
                }}
                disabled={epis.length === 0}
                className="flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                data-testid="select-epi"
              >
                <option value="">{epis.length > 0 ? 'Selecione um EPI...' : 'Nenhum EPI disponível para seleção'}</option>
                {epis.map((epi) => (
                  <option key={epi.id} value={epi.id}>
                    {epi.name} - CA: {epi.ca_number || 'N/A'} - Estoque: {epi.current_stock ?? 0}
                    {getEpiSelectionIssue(epi, deliveryType) ? ` - ${getEpiSelectionIssue(epi, deliveryType)}` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className={selectedItems.length > 0 ? 'space-y-2 mb-6' : 'hidden'}>
              <p className="text-sm font-medium text-slate-700">Itens selecionados ({selectedItems.length}):</p>
              {selectedItems.map((item, index) => (
                <div key={item.id || `selected-${item.name}-${index}`} className="flex items-start justify-between gap-3 p-3 bg-slate-50 rounded-md">
                  <div className="flex-1">
                    <p className="font-medium text-slate-900">{item.name}</p>
                    <p className="text-sm text-slate-600">
                      CA: {item.ca_number || 'N/A'}
                      {item.available_stock !== undefined && item.available_stock !== null && (
                        <span> | Estoque: {item.available_stock}</span>
                      )}
                      <span className={item.from_kit ? 'text-blue-600 ml-2' : 'hidden'}>(Kit: {item.from_kit})</span>
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <label className="text-xs font-medium text-slate-600" htmlFor={`delivery-item-quantity-${index}`}>
                        Quantidade
                      </label>
                      <input
                        id={`delivery-item-quantity-${index}`}
                        type="number"
                        min="1"
                        max={deliveryType === 'return' ? undefined : getItemAvailableStock(item)}
                        step="1"
                        value={item.quantity || 1}
                        onChange={(event) => updateItemQuantity(index, event.target.value)}
                        className="h-9 w-24 rounded-md border border-slate-300 bg-white px-3 py-1 text-sm"
                      />
                    </div>
                    {getSelectedItemBlockingReason(item) && (
                      <p className="mt-2 text-xs font-medium text-red-600">
                        {getSelectedItemBlockingReason(item)}
                      </p>
                    )}
                    {item.requires_variation_selection && (
                      <div className="mt-2">
                        <select
                          value={item.epi_variation_id || ''}
                          onChange={(event) => applyVariationToItem(index, event.target.value)}
                          className="flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                        >
                          <option value="">Selecione tamanho / CA / lote...</option>
                          {(item.available_variations || []).map((variation) => (
                            <option key={variation.id} value={variation.id}>
                              {formatVariationLabel(variation)}
                            </option>
                          ))}
                        </select>
                        {(item.available_variations || []).length === 0 && (
                          <p className="mt-1 text-xs font-medium text-red-600">Sem estoque disponivel para este EPI.</p>
                        )}
                        {item.suggested_variation_id && !item.epi_variation_id && (
                          <p className="mt-1 text-xs text-slate-500">Sugestao conforme cadastro do colaborador: {formatVariationLabel((item.available_variations || []).find((variation) => variation.id === item.suggested_variation_id))}</p>
                        )}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => removeItem(index)}
                    className="text-red-500 hover:text-red-700 p-1"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
              ))}
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleConfirmDelivery}
                disabled={!canConfirmDelivery}
                data-testid="complete-delivery"
                className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white font-medium rounded-md px-4 py-3 flex items-center justify-center gap-2 disabled:opacity-50"
                title={!canConfirmDelivery ? (counterAttendantBlockingReason || firstBlockingItemReason || (!facialMatch?.verified ? 'Verificação facial obrigatória' : 'Adicione pelo menos um item')) : 'Confirmar entrega'}
              >
                <CheckCircle2 className="w-5 h-5" />
                <span>{loading ? 'Processando...' : 'Confirmar'}</span>
              </button>
              <button
                onClick={resetForm}
                className="bg-slate-200 hover:bg-slate-300 text-slate-700 font-medium rounded-md px-6 py-3"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>

        {/* Dialog de Histórico */}
        <Dialog open={showHistoryDialog} onOpenChange={setShowHistoryDialog}>
          <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Histórico - {selectedEmployee?.full_name}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <p className={employeeHistory.length === 0 ? 'text-center text-slate-500 py-8' : 'hidden'}>
                Nenhuma movimentação registrada
              </p>
              <div className={employeeHistory.length > 0 ? 'space-y-3' : 'hidden'}>
                {employeeHistory.map((delivery, idx) => (
                  <div key={delivery.id || `delivery-${delivery.created_at}-${idx}`} className={`p-4 rounded-lg border ${delivery.is_return ? 'bg-blue-50 border-blue-200' : 'bg-emerald-50 border-emerald-200'}`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className={`px-2 py-1 rounded text-xs font-medium ${delivery.is_return ? 'bg-blue-200 text-blue-800' : 'bg-emerald-200 text-emerald-800'}`}>
                        {delivery.is_return ? 'Devolução' : 'Entrega'}
                      </span>
                      <span className="text-sm text-slate-600">
                        {formatDateTimeBR(delivery.created_at)}
                      </span>
                    </div>
                    <div className="space-y-1">
                      {delivery.items?.map((item, i) => (
                        <p key={`${delivery.id || delivery.created_at}-item-${i}`} className="text-sm text-slate-700">
                          • {item.epi_name || item.name} (Qtd: {item.quantity})
                        </p>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}


