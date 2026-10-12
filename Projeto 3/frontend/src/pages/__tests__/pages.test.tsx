import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertsResponse, Balance, Movement } from '../../lib/types';

vi.mock('../../lib/api', () => ({
  api: { balances: vi.fn(), createMovement: vi.fn(), alerts: vi.fn(), movements: vi.fn(), reverseMovement: vi.fn() },
}));

let isManager = false;
vi.mock('../../lib/AuthContext', () => ({
  useAuth: () => ({
    status: 'authenticated',
    user: { id: 'u1', name: 'Ana', email: 'ana@loja.com', role: isManager ? 'GERENTE' : 'ESTOQUISTA' },
    isManager,
  }),
}));

const cafe: Balance = {
  id: 'p1',
  sku: 'CAFE-500',
  barcode: '7891000100103',
  name: 'Café 500g',
  unit: 'UN',
  currentStock: 12,
  safetyStock: 20,
  status: 'BAIXO',
};

function movement(over: Partial<Movement> = {}): Movement {
  return {
    id: 10,
    createdAt: '2026-10-09T18:00:00.000Z',
    productId: 'p1',
    sku: 'CAFE-500',
    productName: 'Café 500g',
    type: 'ENTRADA',
    reason: 'COMPRA',
    quantity: 5,
    signedQuantity: 5,
    balanceBefore: 12,
    balanceAfter: 17,
    documentRef: null,
    notes: null,
    reversalOfId: null,
    reversedById: null,
    userName: 'Ana',
    supplierName: null,
    ...over,
  };
}

async function setup() {
  vi.resetModules();
  const { api } = await import('../../lib/api');
  const { outbox } = await import('../../lib/outbox');
  const { NetworkError } = await import('../../lib/http');
  const { ToastProvider } = await import('../../components/Toast');
  const { default: Movement } = await import('../Movement');
  const { default: Dashboard } = await import('../Dashboard');
  const mocked = api as unknown as Record<'balances' | 'createMovement' | 'alerts' | 'movements', ReturnType<typeof vi.fn>>;
  const wrap = (ui: React.ReactElement) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ToastProvider>{ui}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { mocked, outbox, NetworkError, Movement, Dashboard, wrap };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  isManager = false;
});
afterEach(() => cleanup());

describe('tela de movimentação', () => {
  it('leitor: código + Enter mostra a etiqueta, foca a quantidade e registra com Enter', async () => {
    const { mocked, Movement, wrap } = await setup();
    mocked.balances.mockResolvedValue({ data: [cafe], limit: 5, offset: 0 });
    mocked.createMovement.mockResolvedValue({ data: movement({ balanceBefore: 12, balanceAfter: 17 }) });
    const user = userEvent.setup();
    render(wrap(<Movement />));

    await user.type(screen.getByLabelText(/Código de barras, SKU ou nome/), '7891000100103{Enter}');

    // etiqueta com nome, saldo e código de barras desenhado
    const tag = await screen.findByRole('article', { name: /Café 500g/ });
    expect(within(tag).getByText('12')).toBeTruthy();
    expect(within(tag).getByRole('img', { name: /Código de barras 7891000100103/ })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/Quantidade/)));

    await user.type(screen.getByLabelText(/Quantidade/), '5{Enter}');

    await waitFor(() => expect(mocked.createMovement).toHaveBeenCalledTimes(1));
    const [payload, key] = mocked.createMovement.mock.calls[0];
    expect(payload).toMatchObject({ productId: 'p1', type: 'ENTRADA', reason: 'COMPRA', quantity: 5 });
    expect(key).toMatch(/^[0-9a-f-]{36}$/);

    // saldo novo na etiqueta e foco de volta no leitor, pronto para o próximo produto
    expect(await screen.findByText(/Saldo anterior: 12\. Agora: 17\./)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/Código de barras, SKU ou nome/)));
    expect(screen.getByLabelText(/Quantidade/).matches(':disabled')).toBe(true);
  });

  it('Alt+S troca para saída e o motivo acompanha o tipo', async () => {
    const { mocked, Movement, wrap } = await setup();
    mocked.balances.mockResolvedValue({ data: [cafe], limit: 5, offset: 0 });
    const user = userEvent.setup();
    render(wrap(<Movement />));
    await user.type(screen.getByLabelText(/Código de barras, SKU ou nome/), '7891000100103{Enter}');
    await screen.findByRole('article');

    await user.keyboard('{Alt>}s{/Alt}');
    expect((screen.getByRole('radio', { name: /Saída/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Motivo') as HTMLSelectElement).value).toBe('VENDA');
    expect(screen.getByRole('button', { name: 'Registrar saída' })).toBeTruthy();
  });

  it('servidor fora: guarda a movimentação na fila e avisa, sem perder o trabalho', async () => {
    const { mocked, outbox, NetworkError, Movement, wrap } = await setup();
    mocked.balances.mockResolvedValue({ data: [cafe], limit: 5, offset: 0 });
    mocked.createMovement.mockRejectedValue(new NetworkError('timeout', 'O servidor demorou para responder.'));
    // o app guarda a movimentação para o usuário logado
    const user = userEvent.setup();
    render(wrap(<Movement />));

    await user.type(screen.getByLabelText(/Código de barras, SKU ou nome/), '7891000100103{Enter}');
    await screen.findByRole('article');
    await user.type(screen.getByLabelText(/Quantidade/), '3,5');
    await user.click(screen.getByRole('button', { name: 'Registrar entrada' }));

    await waitFor(() => expect(outbox.getSnapshot()).toHaveLength(1));
    const queued = outbox.getSnapshot()[0];
    expect(queued).toMatchObject({ userId: 'u1', status: 'pending', payload: { quantity: 3.5, productId: 'p1' } });
    expect(await screen.findByText(/Guardada neste aparelho/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Aguardando envio \(1\)/ })).toBeTruthy();
  });

  it('validação: quantidade vazia mostra erro e não envia', async () => {
    const { mocked, Movement, wrap } = await setup();
    mocked.balances.mockResolvedValue({ data: [cafe], limit: 5, offset: 0 });
    const user = userEvent.setup();
    render(wrap(<Movement />));
    await user.type(screen.getByLabelText(/Código de barras, SKU ou nome/), '7891000100103{Enter}');
    await screen.findByRole('article');
    await user.click(screen.getByRole('button', { name: 'Registrar entrada' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/quantidade maior que zero/);
    expect(mocked.createMovement).not.toHaveBeenCalled();
  });

  it('recusa do servidor (saldo insuficiente) aparece no formulário e mantém os dados digitados', async () => {
    const { mocked, Movement, wrap } = await setup();
    const { ApiError } = await import('../../lib/http');
    mocked.balances.mockResolvedValue({ data: [cafe], limit: 5, offset: 0 });
    mocked.createMovement.mockRejectedValue(new ApiError(422, 'INSUFFICIENT_STOCK', 'estoque insuficiente (saldo 12, solicitado 99)'));
    const user = userEvent.setup();
    render(wrap(<Movement />));
    await user.type(screen.getByLabelText(/Código de barras, SKU ou nome/), '7891000100103{Enter}');
    await screen.findByRole('article');
    await user.keyboard('{Alt>}s{/Alt}');
    await user.type(screen.getByLabelText(/Quantidade/), '99{Enter}');
    expect((await screen.findByRole('alert')).textContent).toMatch(/estoque insuficiente/);
    expect((screen.getByLabelText(/Quantidade/) as HTMLInputElement).value).toBe('99');
  });

  it('custo unitário só aparece para o Gerente, e só em entradas', async () => {
    const first = await setup();
    first.mocked.balances.mockResolvedValue({ data: [cafe], limit: 5, offset: 0 });
    const user = userEvent.setup();
    render(first.wrap(<first.Movement />));
    await user.type(screen.getByLabelText(/Código de barras, SKU ou nome/), '7891000100103{Enter}');
    await screen.findByRole('article');
    expect(screen.queryByLabelText(/Custo unitário/)).toBeNull();
    cleanup();

    isManager = true;
    const second = await setup();
    second.mocked.balances.mockResolvedValue({ data: [cafe], limit: 5, offset: 0 });
    render(second.wrap(<second.Movement />));
    await user.type(screen.getByLabelText(/Código de barras, SKU ou nome/), '7891000100103{Enter}');
    await screen.findByRole('article');
    expect(screen.getByLabelText(/Custo unitário/)).toBeTruthy();
  });
});

describe('painel', () => {
  it('mostra contadores, itens críticos em ordem e as últimas movimentações', async () => {
    const { mocked, Dashboard, wrap } = await setup();
    const alerts: AlertsResponse = {
      summary: { zerado: 1, baixo: 1, total: 2 },
      data: [
        { ...cafe, id: 'a', name: 'Arroz 5kg', sku: 'ARROZ-5', currentStock: 0, status: 'ZERADO', shortfall: 10, preferredSupplier: 'Distribuidora Sul' },
        { ...cafe, shortfall: 8, preferredSupplier: null },
      ],
    };
    mocked.alerts.mockResolvedValue(alerts);
    mocked.movements.mockResolvedValue({ data: [movement()], limit: 8, offset: 0 });
    render(wrap(<Dashboard />));

    expect(await screen.findByText('Arroz 5kg')).toBeTruthy();
    expect(screen.getByText('item zerado')).toBeTruthy();
    expect(screen.getByText('item abaixo do mínimo')).toBeTruthy();
    expect(screen.getByText(/Fornecedor preferido: Distribuidora Sul/)).toBeTruthy();
    expect(screen.getAllByText('Zerado').length).toBeGreaterThan(0); // situação em palavras, não só em cor
    expect(await screen.findByText(/Entrada por compra, Ana/)).toBeTruthy();
  });

  it('sem itens críticos mostra a mensagem de tudo em dia', async () => {
    const { mocked, Dashboard, wrap } = await setup();
    mocked.alerts.mockResolvedValue({ summary: { zerado: 0, baixo: 0, total: 0 }, data: [] });
    mocked.movements.mockResolvedValue({ data: [], limit: 8, offset: 0 });
    render(wrap(<Dashboard />));
    expect(await screen.findByText(/Nenhum item no estoque de segurança ou abaixo dele\./)).toBeTruthy();
    expect(await screen.findByText(/Nenhuma movimentação ainda\./)).toBeTruthy();
  });

  it('falha de rede sem dados: explica o que houve e oferece tentar de novo', async () => {
    const { mocked, NetworkError, Dashboard, wrap } = await setup();
    mocked.alerts.mockRejectedValue(new NetworkError('unavailable', 'x'));
    mocked.movements.mockRejectedValue(new NetworkError('unavailable', 'x'));
    render(wrap(<Dashboard />));
    const alerts = await screen.findAllByRole('alert');
    expect(alerts[0].textContent).toMatch(/O servidor está indisponível no momento\./);
    expect(alerts[0].textContent).toMatch(/voltam a aparecer/);
    expect(screen.getAllByRole('button', { name: 'Tentar de novo' }).length).toBeGreaterThan(0);
  });
});
