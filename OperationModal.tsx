import {Modal, TextInput, NumberInput, SegmentedControl, Button, Group, Box, ActionIcon, Tooltip} from '@mantine/core';
import {useUnit} from 'effector-react';
import {
	startTradingFx,
	stopTradingFx,
	setParam,
	$currentTab,
	$localTabIndex,
	changeLocalTab,
	forceExitFx
} from './model/current-operation-store';
import {IconRefresh, IconAlertTriangle} from '@tabler/icons-react';

export const OperationModal = ({tabIndex = 1}: { tabIndex?: number }) => {
	// Получаем индекс, специфичный для этого окна браузера
	const activeTabId = useUnit($localTabIndex);
	const changeTab = useUnit(changeLocalTab);

	// Подтягиваем данные именно для этой вкладки из общего хранилища
	const params = useUnit($currentTab(activeTabId));
	const update = useUnit(setParam);

	const handleChange = (key: any, value: any) => {
		if (key === 'tabIndex') {
			changeTab(value); // Меняем локальный ID окна
		} else {
			update({tabIndex: activeTabId, key, value}); // Обновляем настройки в общем сторе
		}
	};

	const start = useUnit(startTradingFx);
	const stop = useUnit(stopTradingFx);
	const forceExit = useUnit(forceExitFx);

	return (
		<Modal
			opened={true}
			onClose={() => {
			}}
			withCloseButton={false} // Не закрываемая
			title={`Гвардеец # ${activeTabId}`}
			size="sm"
		>
			<Box p="xs">
				{/* Номер вкладки */}
				<NumberInput
					label="Номер вкладки (ID)"
					value={activeTabId}
					onChange={(v) => handleChange('tabIndex', v)}
					mb="sm"
				/>

				<SegmentedControl
					fullWidth
					value={params.operation}
					onChange={(v) => handleChange('operation', v)}
					data={[
						{label: 'LONG', value: 'BuyLimit'},
						{label: 'SHORT', value: 'SellLimit'},
					]}
					mb="sm"
				/>

				<TextInput
					label="Тикер"
					value={params.ticker}
					onChange={(e) => handleChange('ticker', e.currentTarget.value.toUpperCase())}
					mb="sm"
				/>

				<Group grow mb="sm">
					<NumberInput
						label="Кол-во (Qty)"
						value={params.qty}
						onChange={(v) => handleChange('qty', v)}
					/>
					<NumberInput
						label="Стоп % (SL)"
						value={params.slPercent}
						decimalScale={2}       // Замена precision
						fixedDecimalScale
						step={0.1}
						onChange={(v) => handleChange('slPercent', v)}
					/>
				</Group>

				<NumberInput
					label="Зона Суеты (slDistance %)"
					description="Дистанция активации Гвардейца"
					value={params.slDistance}
					decimalScale={2}       // Замена precision
					fixedDecimalScale
					step={0.05}
					onChange={(v) => handleChange('slDistance', v)}
					mb="xl"
				/>

				<Group grow>
					<Button
						color="blue"
						loading={useUnit(startTradingFx.pending)} // Крутилка на кнопке пока идет запуск
						onClick={() => start(params)}
					>
						START
					</Button>

					{/*<Button*/}
					{/*	color="red"*/}
					{/*	variant="outline"*/}
					{/*	onClick={() => stop(params.tabIndex)}*/}
					{/*>*/}
					{/*	STOP / CANCEL*/}
					{/*</Button>*/}
					<Button
						fullWidth
						color="orange"
						variant="outline"
						// leftSection={<IconAlertTriangle size={18} />} // Если есть иконки
						onClick={() => forceExit(params.tabIndex)}
					>
						CLOSE
					</Button>

					<ActionIcon
						variant="subtle"
						color="gray"
						size="lg"
						onClick={() => window.location.reload()}

					>
						<IconRefresh size={20} stroke={1.5}/>
					</ActionIcon>

				</Group>
			</Box>
		</Modal>
	);
};
