import net from 'node:net';

/**
 * Proxy TCP que pode ser derrubado e religado: simula uma queda real de rede entre a API e o PostgreSQL
 * (conexões em curso são destruídas; novas conexões recebem ECONNREFUSED) sem afetar o banco nem outros testes.
 */
export class TcpProxy {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  port = 0;

  constructor(private readonly target: { host: string; port: number }) {}

  /** Sobe o proxy; em religações, reutiliza a mesma porta. */
  async start(): Promise<number> {
    this.server = net.createServer((client) => {
      const upstream = net.connect(this.target.port, this.target.host);
      this.sockets.add(client).add(upstream);
      const close = () => {
        client.destroy();
        upstream.destroy();
        this.sockets.delete(client);
        this.sockets.delete(upstream);
      };
      client.on('error', close).on('close', close);
      upstream.on('error', close).on('close', close);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, '127.0.0.1', () => resolve());
    });
    this.port = (this.server!.address() as net.AddressInfo).port;
    return this.port;
  }

  /** Queda: destrói todas as conexões abertas e para de aceitar novas. */
  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
