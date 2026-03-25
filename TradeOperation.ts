import {BybitDataBus} from "./BybitDataBus";
import {RestClientV5} from 'bybit-api'
import {getBybitKey} from './settings'

const {key, secret} = getBybitKey()
const client = new RestClientV5({
    key: key,
    secret: secret,
    testnet: false,
    parseAPIRateLimits: true,
    enable_time_sync: true, // Бот сам спросит время у Bybit перед стартом
    recv_window: 20000,            // Увеличиваем окно до 20 сек (на случай лагов сети)
});

export class TradeOperation {
    private isStopping: boolean = false;
    private isApiBusy: boolean = false;
    private timer: NodeJS.Timeout | null = null;
    private bus: BybitDataBus;
    private params: any; // Сюда мы сохраним настройки (тикер, qty и т.д.)
    private resolve: (value: string) => void = () => {
    }; // Хранилище для промиса
    private orderId: string = ''
    private tickSize: number = 0
    private slPercent: number = 0.0
    private orderPrice: string = ''
    private orderStopLoss: string = '0'
    private mode: 'ENTRY' | 'WATCH' | 'GUARD' = 'ENTRY';
    private lastRequestTime: number = 0;

    constructor() {
        this.bus = new BybitDataBus();
    }
    private resolve_my: ((value: any) => void) | null = null;

    public async start(params: any) {
        this.params = params;
        this.slPercent = params.slPercent ? params.slPercent : 0

        // 1. Подписываемся и ждем первых цен
        await this.bus.subscribe(params.ticker);

        // В методе start() перед вызовом initialEntry
        console.log("⏳ Ожидание готовности данных DataBus...");

        // Ждем до 5 секунд, пока шина не скажет, что данные по тикеру пришли
        const isReady = await this.bus.waitForData(5000);

        if (!isReady) {
            throw new Error("DataBus Timeout: Данные по тикеру не получены");
        }
        await this.initialEntry(params);

        // 3. Запускаем "Петлю управления"
        this.timer = setInterval(() => this.tick(), 200);

        // Возвращаем промис, который "держит" эффект в сторе активным
        return new Promise((res) => {
            this.resolve = res; // Сохраняем рычаг для завершения
        });
    }

    private async tick() {
        // 1. ПРЕДОХРАНИТЕЛИ: проверка связи и занятости API
        if (this.isStopping || this.isApiBusy || !this.bus.isDataReady) {
            //console.log(`[TICK] Busy: ${this.isApiBusy}, Ready: ${this.bus.isDataReady}, Mode: ${this.mode}`);
            return;
        }
        // Гарантируем паузу 200мс между запросами (наш "бронежилет")
        if (Date.now() - this.lastRequestTime < 200) return;
        // ПРОВЕРКА: А есть ли вообще позиция?
        // Если мы в режиме WATCH или GUARD, но позиция на бирже уже 0
        if (this.mode === 'WATCH' || this.mode === 'GUARD') {
            const pos = await client.getPositionInfo({
                category: 'linear',
                symbol: this.params.ticker
            });
            const list = pos.result.list[0];
            const size = parseFloat(list?.size || "0");

            if (size === 0) {
                console.log("🏁 Позиция закрыта извне (стоп или TP). Завершаем работу.");
                this.stop("Done (External)");
                return;
            }

            // // 2. МОЯ добавка: Скрещиваем "Авто-трекинг стопа"
            const remoteSL = list?.stopLoss || "0";
            //console.log('list',list)
            //console.log('stopLoss',list?.stopLoss)
            //
            // Если на бирже есть стоп и он не совпадает с тем, что в памяти Гвардейца
            if (parseFloat(remoteSL) > 0 && remoteSL !== this.orderStopLoss) {
                console.log(`🔄 [${this.params.ticker}] Стоп изменен вручную: ${this.orderStopLoss} -> ${remoteSL}`);
                this.orderStopLoss = remoteSL; // Гвардеец пересчитывает Зону Суеты на лету
            }
        }

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

                // 2. ФИКС: Если ордер ОТМЕНЕН (например, Post-Only) — ПЕРЕВЫСТАВЛЯЕМ
                if (status === 'Cancelled' || this.orderId === "") {
                    console.warn("⚠️ Входной ордер отменен биржей. Повторная попытка входа...");
                    await this.initialEntry(this.params); // Пробуем зайти снова по новой цене
                    return;
                }
                // ВАЖНО: Если amendOrder вернул ошибку "order not exists"
                // Мы должны СРАЗУ сбросить флаг или вызвать проверку статуса
                const amendResult = await this.handleAmendLogic();

                if (amendResult === 'ERROR_STUCK') {
                    console.warn("Похоже, ордер потерян. Проверяем историю...");
                    // На следующем тике checkOrderStatus всё разрулит
                    return;
                }
                return; // <--- ОБЯЗАТЕЛЬНО добавить здесь
            }
            // --- РЕЖИМ 2: НАБЛЮДЕНИЕ (WATCH) ---
            else if (this.mode === 'WATCH') {
                // Просто измеряем расстояние до стопа
                await this.handleWatchLogic();
                return; // <--- ОБЯЗАТЕЛЬНО добавить здесь
            }

            // --- РЕЖИМ 3: ВЫХОД (GUARD) ---
            else if (this.mode === 'GUARD') {
                // 1. Проверяем статус (если ID стерт, checkOrderStatus полезет в историю)
                const status = await this.checkOrderStatus();


                // В tick() перед тем как написать "Позиция закрыта"
                const pos = await client.getPositionInfo({category: 'linear', symbol: this.params.ticker});
                const size = Math.abs(parseFloat(pos.result.list[0]?.size || "0"));

                if (status === 'Filled' && size === 0) {
                    console.log("✅ ВЫХОД ПОДТВЕРЖДЕН: Позиция реально 0.");
                    this.orderId = ""; // Сбрасываем ID
                    this.orderPrice = "0";
                    this.stop("Done");
                    return
                } else if (status === 'Filled' && size > 0) {
                    console.warn("❌ ОШИБКА: Ордер якобы Filled, но позиция еще есть! Продолжаем GUARD.");
                    this.orderId = ""; // Сбрасываем ID, чтобы перевыставить лимитку
                    // ФИКС №1: Обязательно выходим из тика здесь!
                    // На следующем тике (через 200мс) сработает логика перевыставления (initialExit)
                    return;
                }

                //Если ордер в истории 'Cancelled' или 'Rejected' (Post-Only выбил)
                if ((status === 'Cancelled' || status === 'Rejected' || this.orderId === "") && size > 0) {
                    console.log("⚠️ Ордера на выход нет. Перевыставляю (initialExit)...");
                    await this.initialExit(); // СОЗДАЕМ НОВУЮ ЛИМИТКУ
                    return;
                }

                // 3. Если мы дошли сюда — значит статус НЕ 'Filled'.
                // Но на всякий случай проверяем, есть ли вообще что двигать
                if (!this.orderId) {
                    console.log("⏸ Ждем появления нового orderId...");
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
            // Ищем наш ордер на выход (по ID или по стороне/типу)
            const myExitOrder = res.result.list.find(o => o.orderId === this.orderId);
            //console.log({myExitOrder})
            if (myExitOrder) {
                const remotePrice = myExitOrder.stopLoss;

                // Если цена ордера на бирже изменилась (ты потянул его мышкой)
                if (parseFloat(remotePrice) > 0 && remotePrice !== this.orderStopLoss) {
                    console.log(`🎯 Гвардеец подхватил движение ордера: ${this.orderStopLoss} -> ${remotePrice}`);
                    //this.orderStopLoss = remotePrice; // Синхронизируем цель охраны
                }
            }

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
                const histOrder = history.result.list[0];
                // Проверяем, что это именно НАШ ордер на выход
                if (histOrder.orderId === this.orderId && histOrder.orderStatus === 'Filled') {
                    return 'Filled';
                }
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
                tpSlMode: 'Full'//'Partial'
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

        // ПРЕДОХРАНИТЕЛЬ: Если ID пуст - делать тут нечего
        if (!this.orderId || this.orderId === "") {
            return;
        }

        if (this.isApiBusy) {
            return;
        }

        const isLong = this.params.operation === 'BuyLimit';
        const targetPrice = isLong ? this.bus.bid : this.bus.ask;

        // 1. Округляем целевую цену
        const formattedTarget = roundStep(targetPrice, this.tickSize);

        // 2. БАЗОВЫЕ ПРОВЕРКИ
        // Если цена в стакане совпадает с нашим ордером - выходим
        if (formattedTarget === this.orderPrice) return;

        const p1 = parseFloat(formattedTarget);
        const p2 = parseFloat(this.orderPrice);
        // @ts-ignore
        console.log(`[DEBUG] Order: ${this.orderPrice}, Market: ${targetPrice}, Diff: ${Math.abs(parseFloat(this.orderPrice) - targetPrice)}`);
        // ЗАЩИТА: Если цена ордера еще не инициализирована (0 или NaN)
        if (!p2 || isNaN(p1) || isNaN(p2)) {
            // console.log("Ожидание инициализации цен...");
            return;
        }

        // 3. Считаем процент отклонения
        const percentDiff = (Math.abs(p1 - p2) / p2) * 100;

        // 4. ПРОВЕРКА ПОРОГА
        // В режиме GUARD (выход) игнорируем порог для максимальной скорости
        if (this.mode !== 'GUARD' && percentDiff < this.params.minStepToAmend) {
            return;
        }
        try {
            // 5. ОТПРАВКА ЗАПРОСА
            try {
                console.log(`[${this.mode}] Amend ${percentDiff.toFixed(3)}% -> ${formattedTarget}`);
                const isGuard = this.mode === 'GUARD';

                const res = await client.amendOrder({
                    category: 'linear',
                    symbol: this.params.ticker,
                    orderId: this.orderId,
                    price: formattedTarget,
                    // ПРАВКА: Если мы в GUARD, не шлем параметр stopLoss вообще!
                    ...(isGuard ? {} : {stopLoss: this.getStopLoss(isLong ? 'Buy' : 'Sell', p1)})
                });
                if (res.retCode === 0) {
                    this.orderPrice = formattedTarget;
                    this.lastRequestTime = Date.now();
                    console.log(`[OK] ${this.mode} передвинут успешно.`);
                } else {
                    console.error(`Ошибка ${this.mode} Amend:`, res.retMsg);

                    // Если ордера нет (уже исполнен или отменен) - сбрасываем ID
                    // Добавь проверку на "invalid" (это код ошибки 110001 или 20001)
                    // Список "фатальных" ошибок, после которых ордера точно нет
                    const isFatal =
                        res.retMsg.includes("not exists") ||
                        res.retMsg.includes("too late") ||
                        res.retMsg.includes("invalid") ||
                        res.retMsg.includes("not found");
                    if (isFatal) {
                        console.warn("🛑 КРИТИЧЕСКИЙ СБРОС ID: Ордер потерян. Очистка...");
                        this.orderId = "";      // Стираем ID
                        this.orderPrice = "0";  // Сбрасываем цену для чистоты
                        return 'ERROR_STUCK';   // Сигнал для выхода из тика
                    } else if (res.retMsg.includes("PartiallyFilled")) {
                        console.log("🧩 Ордер частично исполнен. Замираем и ждем наполнения...");

                        // Обновляем orderPrice текущей ценой, чтобы percentDiff стал 0
                        // и следующая попытка Amend не случилась до изменения цены в стакане
                        this.orderPrice = formattedTarget;

                        return; // Просто выходим из метода, не сбрасывая ID
                    }
                }
            } catch (e: any) {
                console.error(`Критическая ошибка ${this.mode} Amend:`, e.message);
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
            this.orderStopLoss = "0";
            this.mode = 'GUARD';
            await this.initialExit();
        }
    }

    private async initialExit() {
        const isLong = this.params.operation === 'BuyLimit';
        const side = isLong ? 'Sell' : 'Buy'; // Реверс стороны
        const tick = this.tickSize;
        // @ts-ignore
        const exitPriceStr = isLong ? (this.bus.ask + tick) : (this.bus.bid - tick)
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
        if (this.isStopping) return; // Если уже останавливаемся - игнорируем повторы
        this.isStopping = true;

        console.log(`🛑 ОСТАНОВКА: ${reason}`);

        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }

        this.orderId = ""; // Стираем ID сразу, чтобы Amend не прошел
        this.bus.stop();

        if (this.resolve) {
            this.resolve(reason);
            // @ts-ignore
            this.resolve = null;
        }
    }
    public async forceExit() {
        console.log(`🚨 [${this.params.ticker}] ЭКСТРЕННЫЙ ВЫХОД (БЕЗОПАСНЫЙ РЕЖИМ)`);

        this.mode = 'GUARD';

        // 1. Сначала вызываем initialExit.
        // Он выставит лимитку со сдвигом в 1 тик (наш "мягкий" выход).
        try {
            await this.initialExit();

            // 2. Только если лимитка ВСТАЛА (this.orderId теперь не пустой)
            if (this.orderId) {
                console.log("✅ Лимитка выхода в стакане. Снимаю старый системный стоп...");
                // Теперь можно безопасно убрать старые стопы, чтобы они не мешались
                await client.cancelAllOrders({
                    category: 'linear',
                    symbol: this.params.ticker
                });
            }
        } catch (e: any) {
            console.error("❌ Ошибка при forceExit:", e.message);
            // Если лимитка не встала - СТОП ОСТАЕТСЯ НА МЕСТЕ. Ты защищен.
        }
    }
    // public async forceExit() {
    // 	console.log(`🚨 [${this.params.ticker}] ЭКСТРЕННОЕ ЗАКРЫТИЕ ВЫЗВАНО РУКАМИ!`);
    //
    // 	// 1. Блокируем новые тики и останавливаем текущий режим
    // 	this.isStopping = false; // Убедимся, что мы еще работаем
    // 	this.mode = 'GUARD';     // Мгновенно переключаем в режим защиты
    //
    // 	// 2. Стираем старый ID, чтобы tick() на следующем цикле перевыставил ордер
    // 	if (this.orderId) {
    // 		try {
    // 			await client.cancelAllOrders({
    // 				category: 'linear',
    // 				symbol: this.params.ticker
    // 			});
    // 			console.log("Старые ордера отменены.");
    // 		} catch (e) {
    // 			console.warn("Не удалось отменить (возможно, их нет)");
    // 		}
    // 	}
    //
    // 	this.orderId = ""; // Сбрасываем ID, чтобы сработал блок initialExit в tick()
    // 	console.log("Режим переключен в GUARD. Начинаю выход лимитками...");
    // }
    public async emergencyStop() {
        console.log(`🛑 [${this.params?.ticker || '---'}] ВЫЗВАН EMERGENCY STOP`);

        // 1. ОСТАНОВКА ЦИКЛА (Самое важное)
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null; // Обнуляем, чтобы tick больше никогда не вызвался
        }

        // 2. ОЧИСТКА БИРЖИ
        try {
            // Отменяем все активные ордера по тикеру (лимитки входа или выхода)
            if (this.params?.ticker) {
                await client.cancelAllOrders({
                    category: 'linear',
                    symbol: this.params.ticker
                });
                console.log(`[${this.params.ticker}] Все активные ордера отменены.`);
            }
        } catch (e: any) {
            console.warn("Не удалось отменить ордера (возможно, их нет):", e.message);
        } finally {
            // 3. ЗАКРЫТИЕ СОЕДИНЕНИЯ
            // Обязательно вызываем стоп у шины данных, чтобы закрыть WebSocket
            if (this.bus) {
                this.bus.stop();
            }

            // 4. ЗАВЕРШЕНИЕ ПРОМИСА
            // Чтобы await ta.start(params) в сторе наконец-то "отпустило"
            if (this.resolve) {
                this.resolve("Stopped");
            }
        }
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
