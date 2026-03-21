import { createStore, createEvent, sample } from 'effector';
import { useUnit } from 'effector-react';

// 1. Описываем интерфейс нашей операции
interface Operation {
	ticker: string;
	operationType: 'limit'| 'limit_pro';
	side: 'Long' | 'Short';
	qty: number;
	slPercent: number;
	tpPercent: number;
	modalOpen: boolean;
	isActive: boolean;
	status: string;
	slDistance: number;
}

// 2. Дефолтные значения (на случай самого первого запуска)
const DEFAULT_OP: Operation = {
	ticker: 'MNTUSDT',
	operationType: 'limit',
	side: 'Long',
	qty: 1,
	slPercent: 1.0,
	tpPercent: 2.0,
	modalOpen: false,
	isActive: false,
	status: '',
	slDistance: 0.2,
};

// Функция-помощник для загрузки из localStorage
const loadFromStorage = (): Partial<Operation> => {
	try {
		const saved = localStorage.getItem('last_operation_settings');
		return saved ? JSON.parse(saved) : {};
	} catch {
		return {};
	}
};

// --- СОБЫТИЯ ---

// Для внешнего управления (Черный ящик и Кнопка Старт)
export const setStatus = createEvent<string>();
export const setIsActive = createEvent<boolean>();

// Для управления модалкой
export const setIsModal = createEvent<boolean>();
export const startNewOperation = createEvent();

// Для обновления полей в самой форме модалки
export const updateFields = createEvent<Partial<Operation>>();

// --- СТОР ---

export const $operation = createStore<Operation>({ ...DEFAULT_OP, ...loadFromStorage() })
	// Управление модалкой и сброс статуса
	.on(startNewOperation, (state) => ({
		...state,
		...loadFromStorage(), // Подтягиваем последние настройки
		modalOpen: true,
		status: '', // Очищаем старый статус при "New Operation"
	}))
	.on(setIsModal, (state, open) => ({ ...state, modalOpen: open }))

	// Управление активностью и статусом (события для Черного ящика)
	.on(setIsActive, (state, active) => ({ ...state, isActive: active }))
	.on(setStatus, (state, text) => ({ ...state, status: text }))

	// Обновление полей ввода в модалке
	.on(updateFields, (state, fields) => ({ ...state, ...fields }));

// --- LOGIC (Middleware) ---

// Сохраняем настройки в localStorage каждый раз, когда меняются поля ввода
$operation.watch((state) => {
	const settingsToSave = {
		ticker: state.ticker,
		operationType: state.operationType,
		side: state.side,
		qty: state.qty,
		slPercent: state.slPercent,
		tpPercent: state.tpPercent,
		slDistance: state.slDistance,
	};
	localStorage.setItem('last_operation_settings', JSON.stringify(settingsToSave));
});

// --- ХУКИ ДЛЯ REACT ---

export const useOperation = () => useUnit($operation);

// Удобный хук для событий
export const useOperationActions = () => useUnit({
	setStatus,
	setIsActive,
	setIsModal,
	startNewOperation,
	updateFields
});
