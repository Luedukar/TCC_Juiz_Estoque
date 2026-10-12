import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Balance, Movement } from '../../lib/types';

vi.mock('../../lib/api', () => ({
  api: { balances: vi.fn(), movements: vi.fn(), reverseMovement: vi.fn(), createMovement: vi.fn(), alerts: vi.fn() },
}));

const auth = {
  status: 'authenticated',
  user: { id: 'u1', name: 'Ana', email: 'ana@loja.com', role: 'ESTOQUISTA' as 'ESTOQUISTA' | 'GERENTE' },
  isManager: false,
  login: vi.fn(),
  logout: vi.fn(),
  retryBoot: vi.fn(),
};
vi.mock('../../lib/AuthContext', () => ({ useAuth: () => auth }));

// jsdom não implementa <dialog>.showModal(): simulação mínima para testar o diálogo de confirmação
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

const cafe: Balance = { id: 'p1', sku: 'CAFE-500', barcode: '7891000100103', name: 'Café 500g', unit: 'UN', currentStock: 12, safetyStock: 20, status: 'BAIXO' };

const mv = (over: Partial<Movement>): Movement => ({
  id: 1,
  createdAt: '2026-10-09T18:00:00.000Z',
  productId: 'p1',
  sku: 'CAFE-500',
  productName: 'Café 500g',
  type: 'ENTRADA',
  reason: 'COMPRA',
  quantity: 5,
  signedQuantity: 5,
  balanceBefore: 0,
  balanceAfter: 5,
  documentRef: null,
  notes: null,
  reversalOfId: null,
  reversedById: null,
  userName: 'Ana',
  supplierName: null,
  ...over,
});

async function setup() {
  vi.resetModules();
  const { api } = await import('../../lib/api');
  const { connection } = await import('../../lib/connection');
  const { outbox } = await import('../../lib/outbox');
  const http = await import('../../lib/http');
  const { ToastProvider } = await import('../../components/Toast');
  const { default: Kardex } = await import('../Kardex');
  const { default: Login } = await import('../Login');
  const { default: Balances } = await import('../Balances');
  const { ConnectionBanner } = await import('../../components/ConnectionBanner');
  const { ServerDown } = await import('../../components/ServerDown');
  const mocked = api as unknown as Record<'balances' | 'movements' | 'reverseMovement', ReturnType<typeof vi.fn>>;
  const wrap = (ui: React.ReactElement) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ToastProvider>{ui}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { mocked, connection, outbox, ...http, Kardex, Login, Balances, ConnectionBanner, ServerDown, wrap };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  auth.user = { id: 'u1', name: 'Ana', email: 'ana@loja.com', role: 'ESTOQUISTA' };
  auth.isManager = false;
  auth.login.mockReset();
  auth.retryBoot.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('faixa de conexão (tratamento de queda e timeout do servidor)', () => {
  const queued = (userId = 'u1') => ({
    key: crypto.randomUUID(),
    userId,
    payload: { productId: 'p1', type: 'SAIDA' as const, quantity: 2 },
    label: { productName: 'Café 500g', sku: 'CAFE-500', type: 'SAIDA' as const, quantity: 2, unit: 'UN' },
    createdAt: Date.now(),
    status: 'pending' as const,
  });

  it('online e sem pendências: não mostra nada', async () => {
    const { ConnectionBanner, wrap } = await setup();
    const { container } = render(wrap(<ConnectionBanner syncNow={vi.fn()} />));
    expect(container.querySelector('[role]')).toBeNull();
  });

  it('duas falhas seguidas: avisa que está sem conexão, explica que o trabalho fica guardado e mostra a próxima tentativa', async () => {
    const { ConnectionBanner, connection, wrap } = await setup();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    render(wrap(<ConnectionBanner syncNow={vi.fn()} />));

    act(() => {
      connection.reportFailure();
      connection.reportFailure();
    });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Sem conexão com o servidor/);
    expect(alert.textContent).toMatch(/ficam guardadas neste aparelho e são enviadas quando a conexão voltar/);
    expect(alert.textContent).toMatch(/Nova tentativa em \d+ s/);
  });

  it('offline com movimentações na fila: mostra quantas aguardam envio (só as do usuário logado)', async () => {
    const { ConnectionBanner, connection, outbox, wrap } = await setup();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    outbox.add(queued('u1'));
    outbox.add(queued('u1'));
    outbox.add(queued('outro-usuario'));
    render(wrap(<ConnectionBanner syncNow={vi.fn()} />));
    act(() => {
      connection.reportFailure();
      connection.reportFailure();
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(/Aguardando envio: 2\./);
  });

  it('"Tentar agora" sonda /health; quando o servidor responde, a faixa some sozinha', async () => {
    const { ConnectionBanner, connection, wrap } = await setup();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(wrap(<ConnectionBanner syncNow={vi.fn()} />));
    act(() => {
      connection.reportFailure();
      connection.reportFailure();
    });
    await user.click(await screen.findByRole('button', { name: 'Tentar agora' }));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(String(fetchMock.mock.calls[0][0])).toContain('/health');
  });

  it('online com pendências: oferece "Enviar agora" e chama a sincronização', async () => {
    const { ConnectionBanner, outbox, wrap } = await setup();
    outbox.add(queued());
    const syncNow = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(wrap(<ConnectionBanner syncNow={syncNow} />));

    expect((await screen.findByRole('status')).textContent).toMatch(/1 movimentação aguardando envio/);
    await user.click(screen.getByRole('button', { name: 'Enviar agora' }));
    expect(syncNow).toHaveBeenCalledTimes(1);
  });

  it('tela "Servidor fora do ar" (abertura do app sem conexão) permite tentar de novo', async () => {
    const { ServerDown, wrap } = await setup();
    const user = userEvent.setup();
    render(wrap(<ServerDown />));
    expect(screen.getByRole('alert').textContent).toMatch(/Sua sessão está guardada/);
    await user.click(screen.getByRole('button', { name: 'Tentar agora' }));
    expect(auth.retryBoot).toHaveBeenCalledTimes(1);
  });
});

describe('login', () => {
  it('envia o e-mail sem espaços e a senha', async () => {
    const { Login, wrap } = await setup();
    auth.status = 'anonymous';
    auth.login.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(wrap(<Login />));
    await user.type(screen.getByLabelText('E-mail'), '  ana@loja.com ');
    await user.type(screen.getByLabelText('Senha'), 'SenhaForte#2026');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    await waitFor(() => expect(auth.login).toHaveBeenCalledWith('ana@loja.com', 'SenhaForte#2026'));
    auth.status = 'authenticated';
  });

  it('credenciais erradas: mostra a mensagem e libera o botão para nova tentativa', async () => {
    const { Login, ApiError, wrap } = await setup();
    auth.status = 'anonymous';
    auth.login.mockRejectedValue(new ApiError(401, 'INVALID_CREDENTIALS', 'x'));
    const user = userEvent.setup();
    render(wrap(<Login />));
    await user.type(screen.getByLabelText('E-mail'), 'ana@loja.com');
    await user.type(screen.getByLabelText('Senha'), 'errada');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    expect((await screen.findByRole('alert')).textContent).toBe('E-mail ou senha incorretos.');
    expect(screen.getByRole('button', { name: 'Entrar' })).toHaveProperty('disabled', false);
    auth.status = 'authenticated';
  });

  it('servidor fora do ar no login: explica a falha de conexão (e não "senha incorreta")', async () => {
    const { Login, NetworkError, wrap } = await setup();
    auth.status = 'anonymous';
    auth.login.mockRejectedValue(new NetworkError('timeout', 'x'));
    const user = userEvent.setup();
    render(wrap(<Login />));
    await user.type(screen.getByLabelText('E-mail'), 'ana@loja.com');
    await user.type(screen.getByLabelText('Senha'), 'qualquer');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/demorou demais/);
    auth.status = 'authenticated';
  });
});

describe('Kardex: perfis e estorno', () => {
  const rows = [
    mv({ id: 1, type: 'ENTRADA', quantity: 10, balanceBefore: 0, balanceAfter: 10, unitCost: 9.5, documentRef: 'NF-77' }),
    mv({ id: 2, type: 'SAIDA', reason: 'VENDA', quantity: 4, balanceBefore: 10, balanceAfter: 6, reversedById: 3 }),
    mv({ id: 3, type: 'ENTRADA', reason: 'ESTORNO', quantity: 4, balanceBefore: 6, balanceAfter: 10, reversalOfId: 2, notes: 'lançado por engano' }),
  ];

  async function open() {
    const ctx = await setup();
    ctx.mocked.balances.mockResolvedValue({ data: [cafe], limit: 5, offset: 0 });
    ctx.mocked.movements.mockResolvedValue({ data: rows, limit: 50, offset: 0 });
    const user = userEvent.setup();
    render(ctx.wrap(<ctx.Kardex />));
    await user.type(screen.getByLabelText('Escolha o produto'), '7891000100103{Enter}');
    await screen.findByRole('table');
    return { ...ctx, user };
  }

  it('Estoquista vê o extrato com saldo corrente, mas sem coluna de custo e sem botão de estorno', async () => {
    await open();
    expect(screen.getByText(/Estornada pela movimentação 3/)).toBeTruthy();
    expect(screen.getByText(/Estorna a movimentação 2/)).toBeTruthy();
    expect(screen.getByText(/Documento NF-77/)).toBeTruthy();
    expect(screen.getByText('0 → 10')).toBeTruthy();
    expect(screen.queryByText('Custo unit.')).toBeNull();
    expect(screen.queryByText(/9,50/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Estornar' })).toBeNull();
  });

  it('Gerente vê o custo e só pode estornar o que ainda não foi estornado nem é um estorno', async () => {
    auth.user = { ...auth.user, role: 'GERENTE' };
    auth.isManager = true;
    await open();
    expect(screen.getByText('Custo unit.')).toBeTruthy();
    expect(screen.getByText(/9,50/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Estornar' })).toHaveLength(1); // só a movimentação 1
  });

  it('estorno: confirma no diálogo, envia motivo e chave de idempotência, e avisa o resultado', async () => {
    auth.user = { ...auth.user, role: 'GERENTE' };
    auth.isManager = true;
    const { mocked, user } = await open();
    mocked.reverseMovement.mockResolvedValue({ data: mv({ id: 4 }) });

    await user.click(screen.getByRole('button', { name: 'Estornar' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/a original continua no histórico/);
    await user.type(within(dialog).getByLabelText(/Motivo do estorno/), 'duplicado');
    await user.click(within(dialog).getByRole('button', { name: 'Estornar' }));

    await waitFor(() => expect(mocked.reverseMovement).toHaveBeenCalledTimes(1));
    const [id, notes, key] = mocked.reverseMovement.mock.calls[0];
    expect(id).toBe(1);
    expect(notes).toBe('duplicado');
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText(/Estorno registrado: movimentação 1/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('estorno com o servidor fora do ar: o diálogo continua aberto e diz que NADA foi enviado', async () => {
    auth.user = { ...auth.user, role: 'GERENTE' };
    auth.isManager = true;
    const { mocked, NetworkError, user } = await open();
    mocked.reverseMovement.mockRejectedValue(new NetworkError('timeout', 'x'));

    await user.click(screen.getByRole('button', { name: 'Estornar' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Estornar' }));

    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/demorou demais.*O estorno não foi enviado/);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('recusa do servidor no estorno (ex.: estoque já consumido) mostra a mensagem do servidor', async () => {
    auth.user = { ...auth.user, role: 'GERENTE' };
    auth.isManager = true;
    const { mocked, ApiError, user } = await open();
    mocked.reverseMovement.mockRejectedValue(new ApiError(422, 'INSUFFICIENT_STOCK', 'estoque insuficiente (saldo 2, solicitado 10)'));
    await user.click(screen.getByRole('button', { name: 'Estornar' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Estornar' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('estoque insuficiente (saldo 2, solicitado 10)');
  });

  it('produto sem movimentações: mensagem de vazio', async () => {
    const ctx = await setup();
    ctx.mocked.balances.mockResolvedValue({ data: [cafe], limit: 5, offset: 0 });
    ctx.mocked.movements.mockResolvedValue({ data: [], limit: 50, offset: 0 });
    const user = userEvent.setup();
    render(ctx.wrap(<ctx.Kardex />));
    await user.type(screen.getByLabelText('Escolha o produto'), '7891000100103{Enter}');
    expect(await screen.findByText(/ainda não tem movimentações/)).toBeTruthy();
  });
});

describe('Saldos', () => {
  it('lista produtos com situação em palavras, filtra por situação e mostra vazio quando nada casa', async () => {
    const { Balances, mocked, wrap } = await setup();
    mocked.balances.mockResolvedValue({ data: [cafe, { ...cafe, id: 'p2', sku: 'ARROZ-5', name: 'Arroz 5kg', currentStock: 0, status: 'ZERADO' }], limit: 50, offset: 0 });
    const user = userEvent.setup();
    render(wrap(<Balances />));

    expect(await screen.findByText('Arroz 5kg')).toBeTruthy();
    expect(screen.getAllByText('Zerado').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Abaixo do mínimo').length).toBeGreaterThanOrEqual(1);

    mocked.balances.mockClear();
    mocked.balances.mockResolvedValue({ data: [], limit: 50, offset: 0 });
    await user.click(screen.getByRole('radio', { name: 'Zerado' }));
    await waitFor(() => expect(mocked.balances).toHaveBeenCalledWith(expect.objectContaining({ status: 'ZERADO' }), expect.anything()));
    expect(await screen.findByText(/Nenhum produto encontrado/)).toBeTruthy();
  });

  it('servidor fora do ar sem dados: mostra o erro com "Tentar de novo"', async () => {
    const { Balances, mocked, NetworkError, wrap } = await setup();
    mocked.balances.mockRejectedValue(new NetworkError('unavailable', 'x'));
    render(wrap(<Balances />));
    expect((await screen.findByRole('alert')).textContent).toMatch(/indisponível/);
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeTruthy();
  });

  it('"Carregar mais produtos" aparece quando a página veio cheia e pede o próximo bloco', async () => {
    const { Balances, mocked, wrap } = await setup();
    const full = Array.from({ length: 50 }, (_, i) => ({ ...cafe, id: `p${i}`, sku: `S-${i}`, name: `Produto ${i}` }));
    mocked.balances.mockResolvedValueOnce({ data: full, limit: 50, offset: 0 }).mockResolvedValue({ data: [], limit: 50, offset: 50 });
    const user = userEvent.setup();
    render(wrap(<Balances />));
    await user.click(await screen.findByRole('button', { name: 'Carregar mais produtos' }));
    await waitFor(() => expect(mocked.balances).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50 }), expect.anything()));
  });
});
