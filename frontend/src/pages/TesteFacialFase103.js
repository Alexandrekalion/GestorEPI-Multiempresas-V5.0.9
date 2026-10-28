import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import Webcam from 'react-webcam';
import { Camera, CheckCircle2, Play, ShieldCheck, Trash2, Users } from 'lucide-react';
import { API } from '@/config/api';

const endpoint = `${API}/admin/facial-benchmark/phase-10-3`;
const sessionStorageKey = 'gestorepi-phase103-session-id';
const authConfig = () => ({ headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const newBatchId = (prefix) => `${prefix}-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

const captureNativeJpegPair = (webcam) => {
  const video = webcam?.video;
  if (!video || !video.videoWidth || !video.videoHeight) return null;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return { jpeg82: canvas.toDataURL('image/jpeg', 0.82), jpeg95: canvas.toDataURL('image/jpeg', 0.95) };
};

const captureTwoFrames = async (webcam) => {
  const frames82 = [];
  const frames95 = [];
  for (let index = 0; index < 2; index += 1) {
    const pair = captureNativeJpegPair(webcam);
    if (!pair) throw new Error('Camera nao esta pronta.');
    frames82.push(pair.jpeg82);
    frames95.push(pair.jpeg95);
    if (index === 0) await wait(250);
  }
  return { frames82, frames95 };
};

function FrameDetails({ frame }) {
  return (
    <div className="space-y-0.5 border-t border-slate-100 pt-2">
      <p>Frame {frame.frame_index}: {frame.status} � {frame.processing_ms} ms � {frame.image_width}x{frame.image_height}</p>
      <p>Origem: {frame.source} � JPEG {frame.jpeg_quality} � {frame.jpeg_bytes || 'indisponivel'} bytes</p>
      <p>Comparacao: {frame.comparison_executed ? 'sim' : 'nao'} � Referencias: {frame.reference_count}</p>
      <p>Embedding: {frame.embedding_dimension || 'indisponivel'}D � Score: {frame.comparison_executed ? frame.score : 'indisponivel'}</p>
      <p>Identidade selecionada: {frame.selected_identity || 'indisponivel'} � Esperada: {frame.expected_identity || 'n/a'}</p>
      {frame.margin_valid && <p>Segundo candidato: {frame.second_score} � Margem: {frame.margin}</p>}
      {frame.false_acceptance && <p className="font-semibold text-red-700">Possivel falsa aceitacao por score</p>}
    </div>
  );
}

function ScenarioResults({ title, scenarios }) {
  return (
    <section className="space-y-3">
      <h2 className="font-semibold text-slate-900">{title}</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        {Object.entries(scenarios).map(([name, scenario]) => (
          <article key={name} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="font-semibold text-slate-900">{name}</h3>
            <p className="mt-1 text-sm text-slate-600">Score aprovado: {scenario.score_pass_count}/2</p>
            <p className="text-sm text-slate-600">Consenso: {scenario.consensus_two_frames ? 'sim' : 'nao'}</p>
            <p className="text-sm text-slate-600">Decisao: {scenario.decision_approved ? 'aprovada' : 'nao aprovada'}</p>
            <p className="text-sm text-slate-600">Identidade correta: {scenario.identity_correct ? 'sim' : 'nao'}</p>
            <p className="text-sm text-slate-600">Falsa aceitacao: {scenario.false_acceptance_observed ? 'observada' : 'nao observada'}</p>
            <p className="text-sm text-slate-600">Margem: {scenario.margin_evaluable ? `${scenario.margin_pass_count}/2 >= 0,04` : 'nao aplicavel'}</p>
            <p className="mt-2 text-xs text-slate-500">Tempo medio: {scenario.mean_processing_ms} ms � P95: {scenario.p95_processing_ms} ms</p>
            <div className="mt-3 space-y-2 text-xs text-slate-500">
              {scenario.frames.map((frame) => <FrameDetails key={`${name}-${frame.frame_index}`} frame={frame} />)}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export default function TesteFacialFase103() {
  const webcamRef = useRef(null);
  const pendingCrossFrames = useRef({});
  const [mode, setMode] = useState('single');
  const [consent, setConsent] = useState(false);
  const [consentA, setConsentA] = useState(false);
  const [consentB, setConsentB] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [referenceCount, setReferenceCount] = useState(0);
  const [referenceCounts, setReferenceCounts] = useState({ subject_a: 0, subject_b: 0 });
  const [referenceBatchIds, setReferenceBatchIds] = useState({});
  const [activeSubject, setActiveSubject] = useState('');
  const [cameraReadyAt, setCameraReadyAt] = useState(0);
  const [crossStep, setCrossStep] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [results, setResults] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const restoreSession = async () => {
      try {
        const response = await axios.get(`${endpoint}/session`, authConfig());
        if (cancelled) return;
        const data = response.data;
        const restoredMode = data.mode || (data.subject_a_reference_count || data.subject_b_reference_count ? 'cross' : 'single');
        setMode(restoredMode);
        setSessionId(data.session_id);
        setReferenceCount(data.reference_count || 0);
        setReferenceCounts({ subject_a: data.subject_a_reference_count || 0, subject_b: data.subject_b_reference_count || 0 });
        setReferenceBatchIds(data.reference_batch_ids || {});
        setMessage('Sessao temporaria retomada com autenticacao.');
        sessionStorage.setItem(sessionStorageKey, data.session_id);
      } catch (error) {
        sessionStorage.removeItem(sessionStorageKey);
      }
    };
    restoreSession();
    return () => { cancelled = true; };
  }, []);

  const closeSession = async () => {
    if (!sessionId) return;
    try {
      await axios.post(`${endpoint}/close`, { session_id: sessionId }, authConfig());
    } catch (error) {
      setMessage(error.response?.data?.detail || 'Nao foi possivel encerrar a sessao.');
    } finally {
      pendingCrossFrames.current = {};
      sessionStorage.removeItem(sessionStorageKey);
      setSessionId('');
      setReferenceCount(0);
      setReferenceCounts({ subject_a: 0, subject_b: 0 });
      setReferenceBatchIds({});
      setActiveSubject('');
      setCameraReadyAt(0);
      setCrossStep('');
      setResults(null);
    }
  };

  const confirmSubject = async (subject) => {
    const authorized = subject === 'single' ? consent : subject === 'subject_a' ? consentA : consentB;
    if (!authorized || !sessionId) return;
    if (!window.confirm(`Confirme que ${subject === 'single' ? 'a pessoa autorizada' : subject === 'subject_a' ? 'a Pessoa A' : 'a Pessoa B'} esta posicionada sozinha diante da camera.`)) return;
    pendingCrossFrames.current = subject === 'subject_b' ? pendingCrossFrames.current : {};
    setActiveSubject(subject);
    setCameraReadyAt(Date.now());
    setCrossStep(subject === 'subject_b' && pendingCrossFrames.current.subject_a ? 'subject_b_ready' : '');
    if (!referenceBatchIds[subject]) {
      setReferenceBatchIds((current) => ({ ...current, [subject]: newBatchId(`reference-${subject}`) }));
    }
    setMessage(`${subject === 'single' ? 'Pessoa autorizada' : subject === 'subject_a' ? 'Pessoa A' : 'Pessoa B'} confirmada. Aguarde a estabilizacao da camera.`);
    await wait(800);
  };

  const ensureCameraStable = async () => {
    const video = webcamRef.current?.video;
    if (!video || video.readyState < 3 || !video.videoWidth || !video.videoHeight) throw new Error('Camera nao esta pronta.');
    const remaining = Math.max(0, 800 - (Date.now() - cameraReadyAt));
    if (remaining) await wait(remaining);
    if (!webcamRef.current?.video || webcamRef.current.video.readyState < 3) throw new Error('Camera perdeu estabilidade.');
  };

  const startSession = async () => {
    const authorized = mode === 'single' ? consent : consentA && consentB;
    if (!authorized) return;
    setBusy(true);
    setMessage('');
    try {
      const response = await axios.post(`${endpoint}/session`, { consent: true, mode }, authConfig());
      setSessionId(response.data.session_id);
      sessionStorage.setItem(sessionStorageKey, response.data.session_id);
      setMessage(mode === 'single' ? 'Sessao iniciada. Capture referencias temporarias.' : 'Sessao 10.8 iniciada. Capture referencias separadas de A e B.');
    } catch (error) {
      setMessage(error.response?.data?.detail || 'Nao foi possivel iniciar o teste.');
    } finally {
      setBusy(false);
    }
  };

  const captureReference = async (subject = 'single') => {
    if (mode === 'cross' && !(subject === 'subject_a' ? consentA : consentB)) return;
    if (activeSubject !== subject) {
      setMessage('Confirme primeiro a pessoa correta diante da camera.');
      return;
    }
    if (!referenceBatchIds[subject]) return;
    setBusy(true);
    setMessage(`Processando referencia da ${subject === 'subject_a' ? 'Pessoa A' : subject === 'subject_b' ? 'Pessoa B' : 'sessao'}...`);
    try {
      await ensureCameraStable();
      const image = webcamRef.current?.getScreenshot();
      if (!image || !sessionId) throw new Error('Camera nao esta pronta.');
      const response = await axios.post(`${endpoint}/reference`, { session_id: sessionId, image_base64: image, subject, batch_id: referenceBatchIds[subject] }, authConfig());
      if (mode === 'single') setReferenceCount(response.data.reference_count);
      else setReferenceCounts((current) => ({ ...current, [subject]: response.data.reference_count }));
      setMessage('Referencia processada e imagem descartada.');
    } catch (error) {
      setMessage(error.response?.data?.detail || 'Referencia rejeitada.');
    } finally {
      setBusy(false);
    }
  };

  const runSingleComparison = async () => {
    if (!sessionId || referenceCount === 0 || activeSubject !== 'single') {
      setMessage('Confirme a pessoa autorizada antes da identificacao.');
      return;
    }
    setBusy(true);
    setMessage('Capturando duas cenas novas para comparar A, B1 e B2...');
    try {
      await ensureCameraStable();
      const frames = await captureTwoFrames(webcamRef.current);
      const response = await axios.post(`${endpoint}/compare`, { session_id: sessionId, images_base64: frames.frames82, images_b2_base64: frames.frames95, capture_batch_id: newBatchId('capture-single') }, authConfig());
      setResults(response.data);
      setMessage('Comparacao concluida. As imagens de teste foram descartadas.');
    } catch (error) {
      setMessage(error.response?.data?.detail || error.message || 'Falha na comparacao.');
    } finally {
      setBusy(false);
    }
  };

  const runCrossComparison = async () => {
    if (!sessionId || referenceCounts.subject_a === 0 || referenceCounts.subject_b === 0) return;
    setBusy(true);
    try {
      if (!crossStep && activeSubject !== 'subject_a') throw new Error('Confirme a Pessoa A antes da captura.');
      if (crossStep === 'await_b_confirmation' || (crossStep === 'subject_b_ready' && activeSubject !== 'subject_b')) throw new Error('Confirme a Pessoa B antes da captura.');
      await ensureCameraStable();
      const frames = await captureTwoFrames(webcamRef.current);
      if (!crossStep) {
        pendingCrossFrames.current.subject_a = { ...frames, batch_id: newBatchId('capture-a') };
        setCrossStep('await_b_confirmation');
        setMessage('Pessoa A registrada. Confirme manualmente a Pessoa B antes de capturar.');
        return;
      }
      if (crossStep !== 'subject_b_ready') throw new Error('Confirme a Pessoa B antes da captura.');
      pendingCrossFrames.current.subject_b = { ...frames, batch_id: newBatchId('capture-b') };
      const personA = pendingCrossFrames.current.subject_a;
      const response = await axios.post(`${endpoint}/compare`, {
        session_id: sessionId,
        images_base64: personA.frames82,
        images_b2_base64: personA.frames95,
        images_person_b_base64: frames.frames82,
        images_person_b2_base64: frames.frames95,
        capture_a_batch_id: personA.batch_id,
        capture_b_batch_id: pendingCrossFrames.current.subject_b.batch_id,
      }, authConfig());
      setResults(response.data);
      pendingCrossFrames.current = {};
      setCrossStep('');
      setMessage('Teste cruzado concluido. As capturas foram descartadas.');
    } catch (error) {
      setMessage(error.response?.data?.detail || error.message || 'Falha no teste cruzado.');
    } finally {
      setBusy(false);
    }
  };

  const canStart = mode === 'single' ? consent : consentA && consentB;
  const canCompareCross = referenceCounts.subject_a > 0 && referenceCounts.subject_b > 0;

  return (
    <main className="min-h-screen bg-slate-50 p-4 sm:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <header>
          <p className="text-sm font-semibold text-emerald-700">Ferramenta temporaria</p>
          <h1 className="text-2xl font-bold text-slate-900">Teste Facial �w^~)�t Fase 10.3</h1>
          <p className="mt-1 text-sm text-slate-600">Benchmark isolado, sem alterar a biometria de producao.</p>
        </header>

        <section className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" />
            <div className="space-y-1">
              <p className="font-semibold">Privacidade e descarte</p>
              <p>Imagens e embeddings ficam somente na memoria temporaria da sessao e sao descartados ao finalizar ou expirar.</p>
              <p>Os identificadores sao apenas Pessoa A e Pessoa B. A margem 0,04 so e avaliada na galeria conjunta.</p>
            </div>
          </div>
        </section>

        {!sessionId ? (
          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <label className="block text-sm font-semibold text-slate-700">Modo do benchmark</label>
            <select value={mode} onChange={(event) => setMode(event.target.value)} className="mt-2 min-h-11 w-full rounded-md border border-slate-300 px-3 sm:max-w-md">
              <option value="single">Fase 10.3"��y��y� Uma identidade</option>
              <option value="cross">Fase 10.8"��y��y� Teste cruzado de identidades</option>
            </select>
            {mode === 'single' ? (
              <label className="mt-4 flex items-start gap-3 text-sm text-slate-700">
                <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="mt-1 h-4 w-4" />
                <span>Autorizo temporariamente o uso das minhas imagens nesta sessao de benchmark e o descarte ao finalizar.</span>
              </label>
            ) : (
              <div className="mt-4 space-y-3 text-sm text-slate-700">
                <label className="flex items-start gap-3"><input type="checkbox" checked={consentA} onChange={(event) => setConsentA(event.target.checked)} className="mt-1 h-4 w-4" /><span>Pessoa A autoriza individualmente o uso temporario das imagens.</span></label>
                <label className="flex items-start gap-3"><input type="checkbox" checked={consentB} onChange={(event) => setConsentB(event.target.checked)} className="mt-1 h-4 w-4" /><span>Pessoa B autoriza individualmente o uso temporario das imagens.</span></label>
              </div>
            )}
            <button type="button" onClick={startSession} disabled={!canStart || busy} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300">
              <Play className="h-4 w-4" /> Iniciar sessao temporaria
            </button>
          </section>
        ) : (
          <>
            <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mx-auto max-w-md overflow-hidden rounded-lg bg-slate-900">
                <Webcam ref={webcamRef} audio={false} onUserMedia={() => setCameraReadyAt(Date.now())} screenshotFormat="image/jpeg" screenshotQuality={0.95} forceScreenshotSourceSize className="aspect-[4/3] w-full object-cover" videoConstraints={{ facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }} mirrored />
              </div>
              {mode === 'single' ? (
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <button type="button" onClick={() => confirmSubject('single')} disabled={busy || !consent} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-emerald-200 px-3 py-2 text-sm font-semibold text-emerald-700 disabled:cursor-not-allowed disabled:opacity-50">Confirmar pessoa posicionada</button>
                  <button type="button" onClick={() => captureReference()} disabled={busy || referenceCount >= 5} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-slate-800 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"><Camera className="h-4 w-4" /> Referencia ({referenceCount}/5)</button>
                  <button type="button" onClick={runSingleComparison} disabled={busy || referenceCount === 0 || activeSubject !== 'single'} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"><CheckCircle2 className="h-4 w-4" /> Comparar A/B1/B2</button>
                </div>
              ) : (
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <button type="button" onClick={() => confirmSubject('subject_a')} disabled={busy || !consentA || crossStep !== ''} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-emerald-200 px-3 py-2 text-sm font-semibold text-emerald-700 disabled:cursor-not-allowed disabled:opacity-50">Confirmar Pessoa A</button>
                  <button type="button" onClick={() => confirmSubject('subject_b')} disabled={busy || !consentB || (crossStep !== '' && crossStep !== 'await_b_confirmation')} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-emerald-200 px-3 py-2 text-sm font-semibold text-emerald-700 disabled:cursor-not-allowed disabled:opacity-50">Confirmar Pessoa B</button>
                  <button type="button" onClick={() => captureReference('subject_a')} disabled={busy || referenceCounts.subject_a >= 5 || !consentA} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-slate-800 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"><Camera className="h-4 w-4" /> Pessoa A ({referenceCounts.subject_a}/5)</button>
                  <button type="button" onClick={() => captureReference('subject_b')} disabled={busy || referenceCounts.subject_b >= 5 || !consentB} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-slate-800 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"><Camera className="h-4 w-4" /> Pessoa B ({referenceCounts.subject_b}/5)</button>
                  <button type="button" onClick={runCrossComparison} disabled={busy || !canCompareCross || crossStep === 'await_b_confirmation' || (crossStep === 'subject_b_ready' && activeSubject !== 'subject_b')} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"><Users className="h-4 w-4" /> {crossStep === 'subject_b_ready' ? 'Capturar Pessoa B' : 'Capturar Pessoa A'}</button>
                </div>
              )}
              <button type="button" onClick={closeSession} disabled={busy} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-md border border-red-200 px-3 py-2 text-sm font-semibold text-red-700 disabled:opacity-50"><Trash2 className="h-4 w-4" /> Encerrar e descartar</button>
            </section>

            {results?.mode === 'single' && <ScenarioResults title="Resultado da identidade temporaria" scenarios={results.scenarios} />}
            {results?.mode === 'cross' && Object.entries(results.tests).map(([identity, test]) => (
              <div key={identity} className="space-y-3">
                <ScenarioResults title={`${identity === 'subject_a' ? 'Pessoa A' : 'Pessoa B'}"��y��y� propria galeria`} scenarios={test.own_gallery} />
                <ScenarioResults title={`${identity === 'subject_a' ? 'Pessoa A' : 'Pessoa B'}"��y��y� galeria da outra pessoa`} scenarios={test.other_gallery} />
                <ScenarioResults title={`${identity === 'subject_a' ? 'Pessoa A' : 'Pessoa B'}+�u���T galeria conjunta A+B`} scenarios={test.joint_gallery} />
              </div>
            ))}
          </>
        )}

        {message && <p role="status" className="text-sm text-slate-700">{message}</p>}
      </div>
    </main>
  );
}

