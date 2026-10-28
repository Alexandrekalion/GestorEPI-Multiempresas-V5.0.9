import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { BarChart3, FileSpreadsheet, FileText, Printer, RefreshCw } from 'lucide-react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { API } from '@/config/api';
import { getAuthHeader } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); };
const fmt = (n) => Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
const dt = (v) => v ? new Date(v).toLocaleString('pt-BR') : '-';
const dateOnly = (v) => v ? new Date(v).toLocaleDateString('pt-BR') : '-';
const timeOnly = (v) => v ? new Date(v).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '-';

export default function Relatorios() {
  const [tab, setTab] = useState('consumo');
  const [startDate, setStartDate] = useState(today());
  const [endDate, setEndDate] = useState(today());
  const [view, setView] = useState('detail');
  const [filters, setFilters] = useState({ company_id: '', department: '', employee_id: '', epi_id: '', variation: '' });
  const [search, setSearch] = useState('');
  const [returnPage, setReturnPage] = useState(1);
  const [data, setData] = useState({ rows: [], totals: {} });
  const [loading, setLoading] = useState(false);
  const params = useMemo(() => ({ start_date: startDate, end_date: endDate, view, search, ...(tab === 'devolucoes' ? { page: returnPage, page_size: 100 } : {}), ...filters }), [startDate, endDate, view, search, filters, tab, returnPage]);
  const reportPath = useMemo(() => tab === 'consumo' ? 'consumption' : tab === 'devolucoes' ? 'returns' : 'daily-deliveries', [tab]);
  const query = useCallback(() => Object.entries(params).filter(([, v]) => v !== '' && v !== undefined && v !== null).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&'), [params]);
  const load = useCallback(async (signal) => {
    try {
      setLoading(true);
      const r = await axios.get(API + '/reports/' + reportPath + '?' + query(), { headers: getAuthHeader(), signal });
      setData(r.data);
    } catch (e) {
      if (e.code !== 'ERR_CANCELED' && e.name !== 'CanceledError') {
        toast.error(e.response?.data?.detail || 'Erro ao carregar relatório');
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [reportPath, query]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
    // Mantem o fluxo atual: filtros textuais sao aplicados pelo botao Atualizar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, startDate, endDate, view, returnPage]);
  const download = async (kind) => {
    let url = null;
    let a = null;
    try {
      const r = await axios.get(API + '/reports/' + reportPath + '/' + kind + '?' + query(), { headers: getAuthHeader(), responseType: 'blob' });
      url = URL.createObjectURL(r.data);
      a = document.createElement('a');
      a.href = url;
      a.download = (tab === 'consumo' ? 'Relatorio_Consumo_EPI' : tab === 'devolucoes' ? 'Relatorio_Devolucoes_EPI' : 'Relatorio_Entregas') + (kind === 'excel' ? '.xlsx' : '.pdf');
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
    } catch {
      toast.error('Não foi possível gerar o arquivo');
    } finally {
      if (a?.parentNode) a.parentNode.removeChild(a);
      if (url) URL.revokeObjectURL(url);
    }
  };
  const preset = (v) => { const d = v === 'ontem' ? yesterday() : today(); setStartDate(d); setEndDate(d); };
  const setFilter = (k, v) => { setReturnPage(1); setFilters((old) => ({ ...old, [k]: v })); };
  const totalPages = Number(data.total_pages || 1);
  const rows = data.rows || []; const totals = data.totals || {};
  const fields = [['company_id', 'Empresa ID'], ['department', 'Setor'], ['employee_id', 'Colaborador ID'], ['epi_id', 'EPI ID'], ['variation', 'Variação/Tamanho']];
  const headers = tab === 'consumo' ? (view === 'detail' ? ['Data', 'EPI', 'Variação', 'Quantidade', 'Colaborador', 'Empresa', 'Setor'] : ['Agrupamento', 'Variação', 'Quantidade', 'Colaboradores', 'Média']) : tab === 'devolucoes' ? ['Data', 'Hora', 'Colaborador', 'Matrícula', 'Empresa', 'Setor', 'EPI', 'Variação', 'Quantidade', 'Observação', 'Responsável', 'Atendente'] : ['Data', 'Hora', 'Colaborador', 'Matrícula', 'Empresa', 'Setor', 'EPI', 'Variação', 'Qtd.', 'Tipo', 'Responsável', 'Atendente', 'Facial'];
  const cell = (value) => <span>{value}</span>;
  return <DashboardLayout><div className="notranslate space-y-5" translate="no" data-testid="relatorios-page">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-bold text-slate-900">Relatórios</h1><p className="text-sm text-slate-500">Consultas somente leitura do histórico de entregas.</p></div><div className="flex gap-2"><Button variant={tab === 'consumo' ? 'default' : 'outline'} onClick={() => setTab('consumo')}>Consumo</Button><Button variant={tab === 'entregas' ? 'default' : 'outline'} onClick={() => setTab('entregas')}>Entregas diárias</Button><Button variant={tab === 'devolucoes' ? 'default' : 'outline'} onClick={() => setTab('devolucoes')}>Devoluções</Button></div></div>
    <section className="bg-white border border-slate-200 rounded-lg p-4 space-y-3"><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => preset('hoje')}>Hoje</Button><Button size="sm" variant="outline" onClick={() => preset('ontem')}>Ontem</Button><Button size="sm" variant="outline" onClick={load}><RefreshCw className="w-4 h-4 mr-1" />Atualizar</Button><Button size="sm" variant="outline" onClick={() => download('excel')}><FileSpreadsheet className="w-4 h-4 mr-1" />Baixar Excel</Button><Button size="sm" variant="outline" onClick={() => download('pdf')}><FileText className="w-4 h-4 mr-1" />Baixar PDF</Button><Button size="sm" variant="outline" onClick={() => window.print()}><Printer className="w-4 h-4 mr-1" />Imprimir</Button></div>
      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3"><label className="text-xs text-slate-600">Data inicial<input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="mt-1 w-full border rounded-md p-2 text-sm" /></label><label className="text-xs text-slate-600">Data final<input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="mt-1 w-full border rounded-md p-2 text-sm" /></label>{fields.map(([k, label]) => <label key={k} className="text-xs text-slate-600">{label}<input value={filters[k]} onChange={(e) => setFilter(k, e.target.value)} className="mt-1 w-full border rounded-md p-2 text-sm" /></label>)}</div>
      {tab === 'devolucoes' && <label className="block text-xs text-slate-600">Pesquisa textual<input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Colaborador, EPI, setor ou observação" className="mt-1 w-full border rounded-md p-2 text-sm" /></label>}
      {tab === 'consumo' && <label className="text-xs text-slate-600">Visualização<select value={view} onChange={(e) => setView(e.target.value)} className="ml-2 border rounded-md p-2 text-sm"><option value="detail">Detalhada</option><option value="epi">Agrupada por EPI</option><option value="company">Agrupada por empresa</option><option value="department">Agrupada por setor</option><option value="employee">Agrupada por colaborador</option></select></label>}
    </section>
    {tab === 'consumo' ? <div className="grid grid-cols-1 md:grid-cols-3 gap-3"><Metric label="Itens consumidos" value={fmt(totals.quantity)} /><Metric label="Colaboradores atendidos" value={fmt(totals.collaborators)} /><Metric label="Linhas" value={fmt(totals.rows)} /></div> : tab === 'devolucoes' ? <div className="grid grid-cols-2 md:grid-cols-4 gap-3"><Metric label="Devoluções" value={fmt(totals.returns)} /><Metric label="Colaboradores" value={fmt(totals.collaborators)} /><Metric label="Itens" value={fmt(totals.items)} /><Metric label="Quantidade" value={fmt(totals.quantity)} /></div> : <div className="grid grid-cols-2 md:grid-cols-4 gap-3"><Metric label="Entregas" value={fmt(totals.deliveries)} /><Metric label="Colaboradores atendidos" value={fmt(totals.collaborators)} /><Metric label="Itens" value={fmt(totals.items)} /><Metric label="Tipos de EPI" value={fmt(totals.types)} /></div>}
    <div className="bg-white border border-slate-200 rounded-lg overflow-auto"><table className="min-w-full text-sm"><thead className="bg-slate-800 text-white"><tr>{headers.map((h) => <th key={h} className="p-3 text-left whitespace-nowrap"><span>{h}</span></th>)}</tr></thead><tbody>{loading ? <tr><td colSpan={headers.length} className="p-8 text-center"><span>Carregando...</span></td></tr> : rows.length === 0 ? <tr><td colSpan={headers.length} className="p-8 text-center text-slate-500"><BarChart3 className="mx-auto mb-2" /><span>Nenhum registro encontrado</span></td></tr> : rows.map((r, i) => tab === 'consumo' ? <tr key={i} className="border-t">{view === 'detail' && <td className="p-3">{cell(dateOnly(r.record_date))}</td>}<td className="p-3">{cell(r.epi_name || r.company || r.department || r.employee_name)}</td><td className="p-3">{cell(r.variation || '-')}</td><td className="p-3">{cell(fmt(r.quantity))}</td><td className="p-3">{cell(r.employee_name || '-')}</td>{view === 'detail' && <><td className="p-3">{cell(r.company || '-')}</td><td className="p-3">{cell(r.department || '-')}</td></>}</tr> : tab === 'devolucoes' ? <tr key={i} className="border-t"><td className="p-3">{cell(dateOnly(r.record_date))}</td><td className="p-3">{cell(timeOnly(r.record_date))}</td><td className="p-3">{cell(r.employee_name || '-')}</td><td className="p-3">{cell(r.registration_number || '-')}</td><td className="p-3">{cell(r.company || '-')}</td><td className="p-3">{cell(r.department || '-')}</td><td className="p-3">{cell(r.epi_name || '-')}</td><td className="p-3">{cell(r.variation || '-')}</td><td className="p-3">{cell(fmt(r.quantity))}</td><td className="p-3">{cell(r.notes || '-')}</td><td className="p-3">{cell(r.delivered_by || '-')}</td><td className="p-3">{cell(r.attendant || '-')}</td></tr> : <tr key={i} className="border-t"><td className="p-3">{cell(dateOnly(r.record_date))}</td><td className="p-3">{cell(timeOnly(r.record_date))}</td><td className="p-3">{cell(r.employee_name)}</td><td className="p-3">{cell(r.registration_number || '-')}</td><td className="p-3">{cell(r.company || '-')}</td><td className="p-3">{cell(r.department || '-')}</td><td className="p-3">{cell(r.epi_name)}</td><td className="p-3">{cell(r.variation || '-')}</td><td className="p-3">{cell(fmt(r.quantity))}</td><td className="p-3">{cell(r.delivery_type)}</td><td className="p-3">{cell(r.delivered_by)}</td><td className="p-3">{cell(r.attendant || '-')}</td><td className="p-3">{cell(r.facial_validation)}</td></tr>)}</tbody></table></div>
    {tab === 'devolucoes' && totalPages > 1 && <div className="flex items-center justify-between text-sm text-slate-600"><span>Página {returnPage} de {totalPages} · {fmt(data.total_rows)} registros</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={returnPage <= 1} onClick={() => setReturnPage((p) => Math.max(1, p - 1))}>Anterior</Button><Button size="sm" variant="outline" disabled={returnPage >= totalPages} onClick={() => setReturnPage((p) => Math.min(totalPages, p + 1))}>Próxima</Button></div></div>}
  </div></DashboardLayout>;
}
function Metric({ label, value }) { return <div className="bg-white border border-slate-200 rounded-lg p-4"><p className="text-xs uppercase text-slate-500">{label}</p><p className="text-2xl font-bold text-slate-900 mt-1">{value}</p></div>; }
