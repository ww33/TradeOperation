import {BybitDataBus} from "./BybitDataBus.ts";
import {RestClientV5} from 'bybit-api'
import {getBybitKey} from './settings.ts'

const {key, secret} = getBybitKey()
const client = new RestClientV5({key: key, secret: secret, testnet: false, parseAPIRateLimits: true,});

export class TradeOperation {
    private isApiBusy: boolean = false;
    private timer: NodeJS.Timeout | null = null;
    private bus: BybitDataBus;
    private params: any; // Сюда мы сохраним настройки (тикер, qty и т.д.)
    private resolve: (value: string) => void = () => {
    }; // Хранилище для промиса
    private orderId: string = ''
    private tickSize: number = 0
    private slPercent: number = 0.6
    private orderPrice: string = ''
    private orderStopLoss: string = '0'
    private mode: 'ENTRY' | 'WATCH' | 'GUARD' = 'ENTRY';
    private lastRequestTime: number = 0;

    constructor() {
        this.bus = new BybitDataBus();

    }

    public async start(params: any) {
        this.params = params;

        // 1. Подписываемся и ждем первых цен
        await this.bus.subscribe(params.ticker);

        // 2. Создаем первый ордер (Limit Entry)
        await this.initialEntry(params);

        // 3. Запускаем "Петлю управления"
        this.timer = setInterval(() => this.tick(), 200);
    }

    private async tick() {
        // 1. ПРЕДОХРАНИТЕЛИ: проверка связи и занятости API
        if (!this.bus.isDataReady || this.isApiBusy) return;

        // Гарантируем паузу 200мс между запросами (наш "бронежилет")
        if (Date.now() - this.lastRequestTime < 200) return;

        try {
            this.isApiBusy = true;

            // --- РЕЖИМ 1: ВХОД (ENTRY) ---
            if (this.mode === 'ENTRY') {
                const status = await this.checkOrderStatus();

                if (status === 'Filled') {
                    console.log("🎯 ВХОД ИСПОЛНЕН! Переходим в WATCH.");
                    this.mode = 'WATCH';
                    return;
                }

                // ВАЖНО: Если amendOrder вернул ошибку "order not exists"
                // Мы должны СРАЗУ сбросить флаг или вызвать проверку статуса
                const amendResult = await this.handleAmendLogic();

                if (amendResult === 'ERROR_STUCK') {
                    console.warn("Похоже, ордер потерян. Проверяем историю...");
                    // На следующем тике checkOrderStatus всё разрулит
                }
                return; // <--- ОБЯЗАТЕЛЬНО добавить здесь
            }
            else if (this.mode === 'WATCH') {
                // Просто измеряем расстояние до стопа
                await this.handleWatchLogic();
                return; // <--- ОБЯЗАТЕЛЬНО добавить здесь
            }

            // --- РЕЖИМ 3: ВЫХОД (GUARD) ---
            else if (this.mode === 'GUARD') {
                // 1. Проверяем статус (если ID стерт, checkOrderStatus полезет в историю)
                const status = await this.checkOrderStatus();

                // 2. Если ордер в истории 'Cancelled' или 'Rejected' (Post-Only выбил)
                if (status === 'Cancelled' || status === 'Rejected' || this.orderId === "") {
                    console.log("⚠️ Ордера на выход нет. Перевыставляю (initialExit)...");
                    await this.initialExit(); // СОЗДАЕМ НОВУЮ ЛИМИТКУ
                    return;
                }

                if (status === 'Filled') {
                    console.log("✅ ВЫХОД ИСПОЛНЕН! Позиция закрыта.");
                    this.stop("Done");
                    return;
                }

                // 3. Если статус 'New' — продолжаем "погоню"
                await this.handleAmendLogic();
                return; // <--- ОБЯЗАТЕЛЬНО добавить здесь
            }

        } catch (e: any) {
            console.error("Ошибка в цикле tick:", e.message);
        } finally {
            this.isApiBusy = false;
        }
    }

    private async checkOrderStatus(): Promise<string> {
        try {
            // 1. Спрашиваем у Bybit только наш текущий ордер
            const res = await client.getActiveOrders({
                category: 'linear',
                symbol: this.params.ticker,
                orderId: this.orderId,
                limit: 1
            });

            // 2. Если ордер найден в активных — берем его статус (New или PartiallyFilled)
            if (res.retCode === 0 && res.result.list.length > 0) {
                return res.result.list[0].orderStatus;
            }

            // 3. Если в активных ордера нет — значит он либо ИСПОЛНЕН, либо ОТМЕНЕН
            // Идем проверять историю (getHistoryOrders)
            const history = await client.getHistoricOrders({
                category: 'linear',
                symbol: this.params.ticker,
                orderId: this.orderId,
                limit: 1
            });

            if (history.retCode === 0 && history.result.list.length > 0) {
                return history.result.list[0].orderStatus; // Вернет 'Filled' или 'Cancelled'
            }

            return "Unknown"; // Если совсем ничего не нашли
        } catch (e) {
            console.error("Ошибка проверки статуса:", e);
            return "Error";
        }
    }

    private async initialEntry(params: any) {
        try {
            console.log(`[${params.ticker}] Инициализация входа...`);

            // 1. Получаем инфо о монете (шаг цены)
            const info = await client.getInstrumentsInfo({
                category: 'linear',
                symbol: params.ticker
            });

            if (info.retCode !== 0) throw new Error("Не удалось получить tickSize");
            this.tickSize = parseFloat(info.result.list[0].priceFilter.tickSize);

            // 2. Включаем режим Partial для стопов (наша "страховка")
            // @ts-ignore
            await client.setTPSLMode({
                category: 'linear',
                symbol: params.ticker,
                tpSlMode: 'Partial'
            }).catch(() => {
            }); // Игнорируем, если уже включен

            // 3. Определяем начальную цену из нашего DataBus
            const isLong = params.operation === 'BuyLimit';
            const side = isLong ? 'Buy' : 'Sell';
            const startPriceStr = isLong ? this.bus.bid : this.bus.ask;

            const formattedPrice = roundStep(startPriceStr, this.tickSize);
            const formattedSL = this.getStopLoss(side, parseFloat(formattedPrice));

            // 4. Выставляем первый ордер
            const res = await client.submitOrder({
                category: 'linear',
                symbol: params.ticker,
                side: side,
                orderType: 'Limit',
                qty: params.qty.toString(),
                price: formattedPrice,
                stopLoss: formattedSL,
                timeInForce: 'PostOnly', // Только мейкер!
                slTriggerBy: 'LastPrice'
            });
            //initialEntry
            if (res.retCode === 0) {
                this.orderId = res.result.orderId;
                this.orderPrice = formattedPrice;
                this.lastRequestTime = Date.now();
                this.orderStopLoss = formattedSL || '0'
                console.log("Стоп-лосс зафиксирован:", this.orderStopLoss);
                console.log(`[OK] Первый ордер выставлен: ${this.orderId}`);
            } else {
                console.error("Ошибка первого входа:", res.retMsg);
                // Если не выставился — tick() на следующем круге попробует снова
            }

        } catch (e: any) {
            console.error("Критическая ошибка initialEntry:", e.message);
        }
    }

    private getStopLoss(side: 'Buy' | 'Sell', priceNum: number): string | undefined {
        if (this.slPercent === 0) return undefined;
        // 1. Явно преобразуем строку bid из стакана в число
        //const priceNum = parseFloat(entryPrice);

        // Защита: если пришла пустая строка или не число
        if (isNaN(priceNum)) {
            console.error("Ошибка: entryPrice не является числом", priceNum);
            return "0";
        }

        // 2. Рассчитываем коэффициент (минус % для Long, плюс % для Short)
        const multiplier = side === 'Buy' ? (1 - this.slPercent / 100) : (1 + this.slPercent / 100);

        // 3. Считаем сырую цену стопа (число)
        const rawSL = priceNum * multiplier;

        // 4. Округляем через наш хелпер (передаем число и шаг цены)
        // На выходе получаем готовую строку для API Bybit
        const stopLoss = roundStep(rawSL, this.tickSize);

        //console.log(`[SL Calc] Bid: ${entryPrice} -> Side: ${side} -> StopLoss: ${stopLoss}`);

        return stopLoss;
    }

    private async handleAmendLogic(): Promise<string | void> {
        const isLong = this.params.operation === 'BuyLimit';
        const targetPrice = isLong ? this.bus.bid : this.bus.ask;
        const formattedTarget = roundStep(targetPrice, this.tickSize);

        // 2. СРАВНИВАЕМ СТРОКИ. Если они идентичны — выходим
        if (formattedTarget === this.orderPrice) return;

        // 3. Считаем процент отклонения
        const p1 = parseFloat(formattedTarget);
        const p2 = parseFloat(this.orderPrice);
        const percentDiff = (Math.abs(p1 - p2) / p2) * 100;

        // 4. ГЛАВНОЕ ИЗМЕНЕНИЕ:
        // Если мы ВХОДИМ (ENTRY), то соблюдаем порог (например, 0.1%)
        // Если мы СПАСАЕМСЯ (GUARD), то ПЛЕВАТЬ на порог — двигаем за каждым тиком!
        if (this.mode !== 'GUARD' && percentDiff < this.params.minStepToAmend) {
            return;
        }

        // 5. Шлем Amend
        console.log(`[${this.mode}] Amend ${percentDiff.toFixed(3)}% -> ${formattedTarget}`);
        // // 1. Выбираем целевую цену (Long следит за Bid, Short за Ask)
        // const isLong = this.params.operation === 'BuyLimit';
        // const targetPrice = isLong ? this.bus.bid : this.bus.ask;
        // const formattedTarget = roundStep(targetPrice, this.tickSize);
        // // 2. СРАВНИВАЕМ СТРОКИ. Если они идентичны — выходим без расчетов
        // if (formattedTarget === this.orderPrice) return// console.log("Цена в стакане совпадает с нашим ордером. Пропускаем.");
        // // 3. Только если цены РАЗНЫЕ, считаем процент для лога
        // const p1 = parseFloat(formattedTarget);
        // const p2 = parseFloat(this.orderPrice);
        // const percentDiff = (Math.abs(p1 - p2) / p2) * 100;
        // // 4. Если процент всё равно мизерный — тоже выходим
        // if (percentDiff < this.params.minStepToAmend) return;
        // // 5. Вот теперь шлем Amend
        // console.log(`Amend ${percentDiff.toFixed(3)}% -> ${formattedTarget}`);

        try {
            const side = isLong ? 'Buy' : 'Sell';

            // Округляем цену входа и стоп-лосса
            const formattedPrice = roundStep(targetPrice, this.tickSize);
            const formattedSL = this.getStopLoss(side, parseFloat(formattedPrice));

            const res = await client.amendOrder({
                category: 'linear',
                symbol: this.params.ticker,
                orderId: this.orderId,
                price: formattedPrice,
                stopLoss: formattedSL,
            });

            if (res.retCode === 0) {
                // ОБЯЗАТЕЛЬНО обновляем текущую цену в памяти, чтобы не зациклиться
                this.orderPrice = formattedPrice;
                console.log(`[OK] Ордер передвинут успешно.`);
            } else {//res.retCode != 0
                // Если ошибка (например, ордер уже исполнился) — tick() на следующем круге
                // вызовет checkOrderStatus и всё поймет сам.
                console.warn("Amend отклонен биржей:", res.retMsg);
                // Если ордера нет — значит его НЕТ. Останавливаем попытки.
                if (res.retMsg.includes("not exists") || res.retMsg.includes("too late")) {
                    this.orderId = ""; // Это заставит checkOrderStatus в след. тике лезть в историю
                    this.orderPrice = "0";
                }
                return 'ERROR_STUCK';
            }
        } catch (e: any) {
            console.error("Критическая ошибка Amend:", e.message);
        }
    }

    private async handleWatchLogic() {
        const currentPrice = parseFloat(this.bus.bid); // Для Long следим за Bid
        const slPrice = parseFloat(this.orderStopLoss);

        if (isNaN(currentPrice) || slPrice === 0) return;

        // Считаем дистанцию до стопа в %
        const distance = Math.abs(currentPrice - slPrice) / currentPrice * 100;

        // Если цена подошла ближе, чем 0.2% (наша "Зона Суеты")
        if (distance <= this.params.slDistance) {
            console.log(`⚠️ ПЕРЕХВАТ! Дистанция ${distance.toFixed(3)}%. Отодвигаем стоп биржи...`);

            // 1. Вместо ОТМЕНЫ мы РЕДАКТИРУЕМ стоп-лосс, отодвигая его еще на 0.5% ниже
            // Это наш "Страховочный пояс", если лимитки не справятся.
            const isLong = this.params.operation === 'BuyLimit';
            const safetyBuffer = isLong ? 0.995 : 1.005; // -0.5% для лонга, +0.5% для шорта
            const emergencySL = (parseFloat(this.orderStopLoss) * safetyBuffer).toString();

            await client.amendOrder({
                category: 'linear',
                symbol: this.params.ticker,
                orderId: this.orderId, // Двигаем наш входной ордер (или позицию)
                stopLoss: roundStep(emergencySL, this.tickSize),
            }).catch(() => console.log("Не удалось отодвинуть стоп, возможно он уже сработал"));

            // 2. Теперь спокойно выставляем лимитку на выход
            await this.initialExit();
            this.mode = 'GUARD';
        }
    }

    private async initialExit() {
        const isLong = this.params.operation === 'BuyLimit';
        const side = isLong ? 'Sell' : 'Buy'; // Реверс стороны
        const exitPriceStr = isLong ? this.bus.ask : this.bus.bid;
        const formattedPrice = roundStep(exitPriceStr, this.tickSize);

        const res = await client.submitOrder({
            category: 'linear',
            symbol: this.params.ticker,
            side: side,
            orderType: 'Limit',
            qty: this.params.qty.toString(),
            price: formattedPrice,
            timeInForce: 'PostOnly',
            reduceOnly: true // ГАРАНТИЯ: только закрываем позицию
        });

        if (res.retCode === 0) {
            this.orderId = res.result.orderId; // Перезаписываем ID на новый (выходной)
            this.orderPrice = formattedPrice;
            console.log(`[GUARD] Лимитка на выход выставлена: ${this.orderId}`);
        }
    }

    private stop(reason: string) {
        if (this.timer) clearInterval(this.timer);
        this.bus.stop();
        this.resolve(reason);
    }
}

function roundStep(value: string | number, step: number): string {
    // 1. Явно преобразуем значение в число (на случай, если пришла строка)
    const numValue = typeof value === 'string' ? parseFloat(value) : value;

    // Проверка на корректность числа (чтобы не упасть на NaN)
    if (isNaN(numValue)) return "0.0";

    // 2. Считаем количество знаков после запятой у шага (исправил твой индекс [1])
    const stepStr = step.toString();
    const precision = stepStr.includes('.')
        ? stepStr.split('.')[1].length
        : 0;

    // 3. Математическое округление до ближайшего шага
    // (numValue / step) дает количество "шагов", округляем его и умножаем обратно
    const rounded = Math.round(numValue / step) * step;

    // 4. Возвращаем строку с нужной бирже точностью
    return rounded.toFixed(precision);
}