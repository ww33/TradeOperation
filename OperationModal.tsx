import React from 'react';
import {
	Modal, TextInput, Select, NumberInput, SegmentedControl,
	Button, Stack, Text, Badge, Group, Divider, Paper
} from '@mantine/core';
import { useOperation, useOperationActions } from './model/current-operation-store';

export const OperationModal: React.FC = () => {
	// Подключаем наш стор и события
	const op = useOperation();
	const { setIsModal, updateFields, setIsActive } = useOperationActions();

	const handleStartStop = () => {
		if (op.isActive) {
			// Логика ОСТАНОВКИ
			setIsActive(false);
			// Тут будет вызов метода "черного ящика" для отмены ордеров
		} else {
			// Логика СТАРТА
			setIsActive(true);
			// Тут будет вызов метода "черного ящика" для запуска цикла
		}
	};

	return (
		<Modal
			opened={op.modalOpen}
			onClose={() => setIsModal(false)}
			title="Control Panel: Trading Bot"
			size="sm"
			centered
		>
			<Stack gap="md">
				{/* Выбор направления */}
				<SegmentedControl
					fullWidth
					value={op.side}
					onChange={(value) => updateFields({ side: value as 'Long' | 'Short' })}
					data={['Long', 'Short']}
					color={op.side === 'Long' ? 'green' : 'red'}
					disabled={op.isActive} // Блокируем смену стороны во время работы
				/>

				<TextInput
					label="Ticker"
					placeholder="MNTUSDT"
					value={op.ticker}
					onChange={(e) => updateFields({ ticker: e.currentTarget.value.toUpperCase() })}
					disabled={op.isActive}
				/>

				<Select
					label="Operation Type"
					placeholder="Выберите тип" // Добавим плейсхолдер
					value={op.operationType} // Убедись, что тут 'limit' или 'limit_pro'
					onChange={(value) => updateFields({ operationType: value as 'limit' | 'limit_pro' })}
					data={[
						{ value: 'limit', label: 'Basic Limit Entry' },
						{ value: 'limit_pro', label: 'Limit Pro (Chase SL)' },
					]}
					disabled={op.isActive}
					allowDeselect={false} // Чтобы нельзя было сбросить в пустоту
				/>

				<Group grow>
					<NumberInput
						label="Qty (Lots)"
						value={op.qty}
						onChange={(val) => updateFields({ qty: Number(val) })}
						min={0}
						disabled={op.isActive}
					/>
				</Group>

				<Group grow>
					<NumberInput
						label="SL %"
						value={op.slPercent}
						onChange={(val) => updateFields({ slPercent: Number(val) })}
						decimalScale={2}
						disabled={op.isActive}
					/>
					<NumberInput
						label="TP %"
						value={op.tpPercent}
						onChange={(val) => updateFields({ tpPercent: Number(val) })}
						decimalScale={2}
						disabled={op.isActive}
					/>
				</Group>

				{/* Условное поле для режима Limit Pro */}
				{op.operationType === 'limit_pro' && (
					<NumberInput
						label="SL Activation Distance (%)"
						description="Расстояние до стопа для начала погони"
						value={op.slDistance}
						onChange={(val) => updateFields({ slDistance: Number(val) })}
						decimalScale={2}
						disabled={op.isActive}
					/>
				)}

				<Divider my="xs" label="Execution Status" labelPosition="center" />

				{/* Блок статуса */}
				<Paper withBorder p="xs" bg="var(--mantine-color-gray-0)">
					<Group justify="space-between" mb={5}>
						<Text size="xs" c="dimmed">Status:</Text>
						{op.isActive && <Badge variant="dot" color="blue">Running</Badge>}
					</Group>
					<Text size="sm" fw={500} c={op.isActive ? 'blue' : 'gray'}>
						{op.status || 'Ready to start...'}
					</Text>
				</Paper>

				{/* Кнопка-Трансформер */}
				<Button
					fullWidth
					size="lg"
					color={op.isActive ? 'red' : 'blue'}
					onClick={handleStartStop}
				>
					{op.isActive ? 'STOP OPERATION' : 'START OPERATION'}
				</Button>
			</Stack>
		</Modal>
	);
};
