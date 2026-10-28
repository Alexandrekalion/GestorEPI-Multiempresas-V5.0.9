import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { AlertTriangle, Bell, CalendarClock, ChevronRight, Clock, GraduationCap, Package, RefreshCw, Search, ShieldAlert, Warehouse, XCircle } from 'lucide-react';
import axios from 'axios';
import { getAuthHeader } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { API } from '@/config/api';

const emptyAlerts = {
  alerts: [],
  alerts_by_type: {},
  summary: {},
  metadata: { stock_visible: false }
};

const alertCards = [
  { type: 'pending_epi', label: 'EPIs Obrigatórios Pendentes', shortLabel: 'EPIs Pendentes', icon: Package, tone: 'orange' },
  { type: 'replacement_expiring', label: 'Trocas a Vencer', shortLabel: 'Trocas a Vencer', icon: CalendarClock, tone: 'amber' },
  { type: 'replacement_due', label: 'Trocas Vencidas', shortLabel: 'Trocas Vencidas', icon: Clock, tone: 'red' },
  { type: 'stock_low', label: 'Estoque Baixo', shortLabel: 'Estoque Baixo', icon: Warehouse, tone: 'amber', stock: true },
  { type: 'stock_zero', label: 'Estoque Zerado', shortLabel: 'Estoque Zerado', icon: ShieldAlert, tone: 'red', stock: true },
  { type: 'ca_expiring', label: 'CA a Vencer', shortLabel: 'CA a Vencer', icon: AlertTriangle, tone: 'amber', stock: true },
  { type: 'ca_expired', label: 'CA Vencido', shortLabel: 'CA Vencido', icon: XCircle, tone: 'red', stock: true },
  { type: 'course_expiring', label: 'Cursos a Vencer', shortLabel: 'Cursos a Vencer', icon: GraduationCap, tone: 'amber' },
  { type: 'course_expired', label: 'Cursos Vencidos', shortLabel: 'Cursos Vencidos', icon: XCircle, tone: 'red' }
];

const toneClasses = {
  orange: {
    active: 'border-orange-500 bg-orange-50',
    hover: 'hover:border-orange-300',
    iconBg: 'bg-orange-100',
    icon: 'text-orange-600',
    badge: 'bg-orange-100 text-orange-700'
  },
  amber: {
    active: 'border-amber-500 bg-amber-50',
    hover: 'hover:border-amber-300',
    iconBg: 'bg-amber-100',
    icon: 'text-amber-600',
    badge: 'bg-amber-100 text-amber-700'
  },
  red: {
    active: 'border-red-500 bg-red-50',
    hover: 'hover:border-red-300',
    iconBg: 'bg-red-100',
    icon: 'text-red-600',
    badge: 'bg-red-100 text-red-700'
  }
};

const formatDate = (value) => value ? new Date(value).toLocaleDateString('pt-BR') : '-';
const getCount = (data, type) => Number(data?.summary?.[type] ?? data?.[`total_${type}`] ?? 0);

function collectItems(data) {
  if (Array.isArray(data?.alerts)) return data.alerts;
  if (data?.alerts_by_type) return Object.values(data.alerts_by_type).flat();

  const keys = ['pending_epis', 'replacement_expiring', 'replacement_due', 'stock_low', 'stock_zero', 'ca_expiring', 'ca_expired', 'course_expiring', 'course_expired'];
  return keys.flatMap((key) => (data?.[key] || []).map((item) => ({ ...item, type: key === 'pending_epis' ? 'pending_epi' : key })));
}

export default function Alertas() {
  const navigate = useNavigate();
  const [alerts, setAlerts] = useState(emptyAlerts);
  const [loading, setLoading] = useState(true);
  const [activeType, setActiveType] = useState('pending_epi');
  const [filters, setFilters] = useState({ search: '', company: '', department: '', epi: '', course: '' });

  useEffect(() => { fetchAlerts(); }, []);

  const fetchAlerts = async () => {
    try {
      setLoading(true);
      const response = await axios.get(`${API}/alerts/all`, { headers: getAuthHeader() });
      setAlerts(response.data || emptyAlerts);
    } catch (error) {
      console.error('Erro ao buscar alertas:', error);
      toast.error('Erro ao carregar alertas');
    } finally {
      setLoading(false);
    }
  };

  const visibleCards = useMemo(() => alertCards.filter((card) => !card.stock || alerts?.metadata?.stock_visible !== false), [alerts]);
  const items = useMemo(() => collectItems(alerts), [alerts]);
  const activeItems = useMemo(() => items.filter((item) => item.type === activeType), [items, activeType]);

  const filteredItems = useMemo(() => {
    const normalizedSearch = filters.search.trim().toLowerCase();
    return activeItems.filter((item) => {
      const values = [item.employee_name, item.employee, item.entity, item.company_name, item.department, item.epi_name, item.name, item.course_name, item.kit_name, item.message, item.status];
      const matchesSearch = !normalizedSearch || values.some((value) => (value || '').toString().toLowerCase().includes(normalizedSearch));
      const matchesCompany = !filters.company || item.company_name === filters.company;
      const matchesDepartment = !filters.department || item.department === filters.department;
      const matchesEpi = !filters.epi || item.epi_name === filters.epi || item.name === filters.epi;
      const matchesCourse = !filters.course || item.course_name === filters.course;
      return matchesSearch && matchesCompany && matchesDepartment && matchesEpi && matchesCourse;
    });
  }, [activeItems, filters]);

  const options = useMemo(() => ({
    companies: unique(items.map((item) => item.company_name)),
    departments: unique(items.map((item) => item.department)),
    epis: unique(items.map((item) => item.epi_name || item.name)),
    courses: unique(items.map((item) => item.course_name))
  }), [items]);

  const activeCard = alertCards.find((card) => card.type === activeType) || alertCards[0];
  const totalAlerts = Number(alerts?.total_alerts ?? alerts?.summary?.total ?? items.length ?? 0);

  if (loading) {
    return <DashboardLayout><div className="flex justify-center py-12"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-emerald-500" /></div></DashboardLayout>;
  }

  return <DashboardLayout><div className="space-y-6" data-testid="alertas-page">
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight flex items-center gap-3"><Bell className="w-8 h-8 text-orange-500" />Central de Alertas</h1>
        <p className="text-slate-600 mt-1">{totalAlerts} alerta(s) operacional(is)</p>
      </div>
      <Button onClick={fetchAlerts} variant="outline" className="gap-2 w-full sm:w-auto"><RefreshCw className="w-4 h-4" />Atualizar</Button>
    </div>

    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5 gap-4">
      {visibleCards.map((card) => <SummaryCard key={card.type} card={card} value={getCount(alerts, card.type)} active={activeType === card.type} onClick={() => setActiveType(card.type)} />)}
    </div>

    <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
      <div className="p-4 bg-slate-50 border-b border-slate-200 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
        <div className="relative xl:col-span-2">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
          <Input value={filters.search} onChange={(event) => setFilter(setFilters, 'search', event.target.value)} className="pl-9" placeholder="Buscar colaborador, EPI, curso, empresa" />
        </div>
        <AlertSelect value={filters.company} setValue={(value) => setFilter(setFilters, 'company', value)} options={options.companies} label="Todas as empresas" />
        <AlertSelect value={filters.department} setValue={(value) => setFilter(setFilters, 'department', value)} options={options.departments} label="Todos os setores" />
        {activeType.startsWith('course_') ? <AlertSelect value={filters.course} setValue={(value) => setFilter(setFilters, 'course', value)} options={options.courses} label="Todos os cursos" /> : <AlertSelect value={filters.epi} setValue={(value) => setFilter(setFilters, 'epi', value)} options={options.epis} label="Todos os EPIs" />}
      </div>

      <div className="px-4 py-3 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">{activeCard.label}</h2>
        <span className="text-sm text-slate-500">{filteredItems.length} de {activeItems.length} item(ns)</span>
      </div>

      <div className="divide-y divide-slate-200">
        {filteredItems.length === 0 ? <Empty card={activeCard} /> : filteredItems.map((item, index) => <AlertRow key={item.id || `${activeType}-${index}`} item={item} card={activeCard} navigate={navigate} />)}
      </div>
    </div>
  </div></DashboardLayout>;
}

function unique(values) { return [...new Set(values.filter(Boolean))].sort(); }
function setFilter(setFilters, key, value) { setFilters((current) => ({ ...current, [key]: value })); }

function SummaryCard({ card, value, active, onClick }) {
  const Icon = card.icon;
  const tone = toneClasses[card.tone];
  return <button onClick={onClick} className={`p-4 rounded-lg border-2 text-left transition-all ${active ? tone.active : `border-slate-200 bg-white ${tone.hover}`}`}>
    <div className="flex items-center gap-4">
      <div className={`w-12 h-12 ${tone.iconBg} rounded-lg flex items-center justify-center flex-shrink-0`}><Icon className={`w-6 h-6 ${tone.icon}`} /></div>
      <div className="min-w-0">
        <p className="text-3xl font-bold text-slate-900 font-mono">{value}</p>
        <p className="text-sm text-slate-600 leading-tight">{card.shortLabel}</p>
      </div>
    </div>
  </button>;
}

function AlertRow({ item, card, navigate }) {
  const Icon = card.icon;
  const tone = toneClasses[card.tone];
  const canOpenEmployee = Boolean(item.employee_id);
  const primary = item.employee_name || item.employee || item.entity || item.epi_name || item.name || item.course_name || card.label;
  const secondary = item.message || item.action_required || item.description;

  return <div className="p-4 hover:bg-slate-50 transition-colors">
    <div className="flex items-start gap-4">
      <div className={`w-10 h-10 ${tone.iconBg} rounded-lg flex items-center justify-center flex-shrink-0`}><Icon className={`w-5 h-5 ${tone.icon}`} /></div>
      <div className="flex-1 min-w-0">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
          <div className="min-w-0">
            <h4 className="font-medium text-slate-900 break-words">{primary}</h4>
            {secondary && <p className="text-sm text-slate-600 mt-1 break-words">{secondary}</p>}
          </div>
          <span className={`px-2 py-1 rounded text-xs font-medium whitespace-nowrap ${tone.badge}`}>{item.severity || item.status || card.shortLabel}</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
          {item.company_name && <span>Empresa: {item.company_name}</span>}
          {item.department && <span>Setor: {item.department}</span>}
          {item.kit_name && <span>Kit: {item.kit_name}</span>}
          {(item.epi_name || item.name) && <span>EPI: {item.epi_name || item.name}</span>}
          {item.variation_name && <span>Variação: {item.variation_name}</span>}
          {item.course_name && <span>Curso: {item.course_name}</span>}
          {item.current_stock !== undefined && <span>Estoque: {item.current_stock}</span>}
          {item.min_stock !== undefined && <span>Mínimo: {item.min_stock}</span>}
          {item.ca_number && <span>CA: {item.ca_number}</span>}
          {item.relevant_date && <span>Data: {formatDate(item.relevant_date)}</span>}
          {item.expiration_date && <span>Validade: {formatDate(item.expiration_date)}</span>}
          {item.days_until_expiration !== undefined && <span>Dias: {item.days_until_expiration}</span>}
          {item.days_overdue !== undefined && <span>Atraso: {item.days_overdue} dia(s)</span>}
        </div>
        {item.missing_epis?.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{item.missing_epis.map((epi, index) => <span key={`${epi.id || epi.name}-${index}`} className="px-2 py-1 bg-orange-100 text-orange-700 rounded text-xs font-medium">{epi.name}{epi.ca_number ? ` (CA: ${epi.ca_number})` : ''}</span>)}</div>}
      </div>
      {canOpenEmployee && <Button variant="ghost" size="sm" onClick={() => navigate(`/colaboradores/${item.employee_id}`)} className="flex-shrink-0"><ChevronRight className="w-5 h-5" /></Button>}
    </div>
  </div>;
}

function Empty({ card }) {
  const Icon = card.icon;
  return <div className="p-12 text-center"><Icon className="w-16 h-16 text-emerald-300 mx-auto mb-4" /><h3 className="text-lg font-medium text-slate-900 mb-2">Nenhum alerta</h3><p className="text-slate-600">Não há itens para {card.label.toLowerCase()}.</p></div>;
}

function AlertSelect({ value, setValue, options, label }) {
  return <select value={value} onChange={(event) => setValue(event.target.value)} className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm">
    <option value="">{label}</option>{options.map((option) => <option key={option} value={option}>{option}</option>)}
  </select>;
}
