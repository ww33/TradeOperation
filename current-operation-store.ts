import { createStore, createEvent, createEffect } from 'effector';
import { persist } from 'effector-storage/local';
import { TradeOperation } from './TradeOperation'; // Путь к твоему классу

export interface OperationParams {
	tabIndex: number;
	ticker: string;
	qty: number;
	slPercent: number;
	slDistance: number;
	operation: 'BuyLimit' | 'SellLimit';
}

// Начальные данные для новой вкладки
const defaultParams: OperationParams = {
	tabIndex: 1,
	ticker: 'DOGEUSDT',
	qty: 1,
	slPercent: 1,
	slDistance: 0.2,
	operation: 'BuyLimit',
};

// События
export const setParam = createEvent<{ tabIndex: number; key: keyof OperationParams; value: any }>();
export const loadTab = createEvent<number>();

// 1. Создаем локальный стор для текущего окна (БЕЗ persist!)
// Это заставит каждое окно при открытии иметь свой индекс
export const $localTabIndex = createStore<number>(1);
export const changeLocalTab = createEvent<number>();
$localTabIndex.on(changeLocalTab, (_, next) => next);

// Стор — это объект, где ключи это номера вкладок: { "1": params, "2": params }
export const $allTabsStore = createStore<Record<number, OperationParams>>({
	1: { ...defaultParams, tabIndex: 1 }
})
	.on(setParam, (state, { tabIndex, key, value }) => {
		const currentTab = state[tabIndex] || { ...defaultParams, tabIndex };
		return {
			...state,
			[tabIndex]: { ...currentTab, [key]: value }
		};
	})
	.on(loadTab, (state, tabIndex) => {
		if (!state[tabIndex]) {
			return { ...state, [tabIndex]: { ...defaultParams, tabIndex } };
		}
		return state;
	});

// Сохраняем в localStorage весь объект вкладок
persist({ store: $allTabsStore, key: 'trade_tabs_config' });

// Селектор для удобства получения данных конкретной вкладки в React
export const $currentTab = (tabIndex: number) =>
	$allTabsStore.map(state => state[tabIndex] || { ...defaultParams, tabIndex });

// Объект для хранения живых инстансов (чтобы потом можно было остановить)
const activeOperations: Record<number, TradeOperation> = {};

export const startTradingFx = createEffect(async (params: OperationParams) => {
	console.log(`🚀 ЗАПУСК ГВАРДЕЙЦА #${params.tabIndex} для ${params.ticker}`);

	// 1. ПРОВЕРКА: Если на этой вкладке уже КТО-ТО ЖИВЕТ
	const existingInstance = activeOperations[params.tabIndex];

	if (existingInstance) {
		console.warn(`⚠️ Гвардеец #${params.tabIndex} уже запущен. Останавливаем старый...`);
		// Вызываем наш бронебойный метод остановки
		await existingInstance.emergencyStop();
		// Ждем микро-паузу, чтобы сокеты успели закрыться
		await new Promise(resolve => setTimeout(resolve, 500));
	}

	// Теперь со спокойной душой создаем НОВЫЙ объект
	const ta = new TradeOperation();//Создаем экземпляр операции
	activeOperations[params.tabIndex] = ta;// Сохраняем в реестр, чтобы иметь доступ извне (например, для кнопки STOP)

	try {
		// 3. ЗАПУСК!
		console.log('запуск')
		const result = await ta.start(params);
		console.log(`🏁 Операция #${params.tabIndex} завершена: ${result}`);
		return result;
	} catch (error) {
		console.error(`❌ Ошибка в операции #${params.tabIndex}:`, error);
		throw error;
	} finally {
		// Очищаем реестр после завершения
		delete activeOperations[params.tabIndex];
	}
});

// Эффект для кнопки CANCEL ALL / STOP
export const stopTradingFx = createEffect(async (tabIndex: number) => {
	const instance = activeOperations[tabIndex];
	if (instance) {
		await instance.emergencyStop();
		console.log(`🛑 Гвардеец #${tabIndex} остановлен вручную.`);
	} else {
		console.log({instance})
	}
});

export const forceExitFx = createEffect(async (tabIndex: number) => {
	//console.log('этот код выводится')
	const instance = activeOperations[tabIndex];
	if (instance) {
		await instance.forceExit();
	} else {
		console.warn(`Инстанс для вкладки ${tabIndex} не найден`);
	}
});
