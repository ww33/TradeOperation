import {WebsocketClient} from 'bybit-api'
import {getBybitKey} from './settings'

const {key, secret} = getBybitKey()

export class BybitDataBus {
    private ws: WebsocketClient;
    public bid: string = "0";
    public ask: string = "0";
    private currentSymbol: string = "";

    // Флаг готовности данных
    public isDataReady: boolean = false;

    constructor() {
        this.ws = new WebsocketClient({
            key,
            secret,
            testnet: false,
            // Встроенные настройки реконнекта
            reconnectTimeout: 1000,
        });

        this.setupListeners();
    }

    public async waitForData(timeoutMs: number = 10000): Promise<boolean> {
        console.log(`[DataBus] Начинаю ожидание котировок для ${this.currentSymbol}...`);
        const start = Date.now();

        while (Date.now() - start < timeoutMs) {
            // Проверяем флаг готовности
            if (this.isDataReady) {
                console.log(`[DataBus] ✅ Данные получены через ${Date.now() - start}мс`);
                return true;
            }

            // Каждую секунду пишем в консоль, что мы еще живы
            if ((Date.now() - start) % 1000 < 100) {
                console.log(`[DataBus] Все еще жду... (${Math.round((Date.now() - start)/1000)}с)`);
            }

            await new Promise(resolve => setTimeout(resolve, 200));
        }

        console.error(`[DataBus] ❌ Таймаут! Данные для ${this.currentSymbol} не пришли за ${timeoutMs}мс`);
        return false;
    }

    private setupListeners() {
        // 1. Обработка данных
        this.ws.on('update', (response) => {
            const {topic, data} = response;
            if (topic.startsWith('orderbook')) {
                const b = data.b && data.b.length > 0 ? data.b[0][0] : null;
                const a = data.a && data.a.length > 0 ? data.a[0][0] : null;
                if (b) this.bid = b;
                if (a) this.ask = a;
                if (this.bid !== "0" && this.ask !== "0") this.isDataReady = true;
            }
        });

        // 2. Авто-переподписка при реконнекте
        this.ws.on('reconnected', () => {
            console.warn(`[DataBus] Соединение восстановлено. Переподписка на ${this.currentSymbol}...`);
            this.isDataReady = false;
            if (this.currentSymbol) {
                this.ws.subscribeV5([`orderbook.1.${this.currentSymbol}`], 'linear');
            }
        });

        // 3. Оповещение о потере связи
        this.ws.on('reconnect', () => {
            this.isDataReady = false;
            console.error(`[DataBus] Связь потеряна! Пытаюсь переподключиться...`);
        });
    }

    public async subscribe(symbol: string): Promise<void> {
        this.currentSymbol = symbol;
        this.isDataReady = false;
        this.ws.subscribeV5([`orderbook.1.${symbol}`], 'linear');

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject('DataBus Timeout'), 15000);
            const interval = setInterval(() => {
                if (this.isDataReady) {
                    clearInterval(interval);
                    clearTimeout(timeout);
                    resolve();
                }
            }, 100);
        });
    }

    public stop() {
        this.isDataReady = false; // Сбрасываем флаг готовности

        if (this.ws) {
            // closeAll() — это встроенный метод библиотеки bybit-api,
            // который рубит все активные соединения и подписки
            this.ws.closeAll();
            console.log("[DataBus] Соединение с сокетом закрыто");
        }
    }
}

