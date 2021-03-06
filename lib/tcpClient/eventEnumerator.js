import connectionManager from './connectionManager';
import mapEvents from './utilities/mapEvents';
import debugModule from 'debug';
import assert from 'assert';

const debug = debugModule('geteventstore:eventEnumerator');
const baseErr = 'Event Enumerator - ';

const getNextBatch = async (config, streamName, state, length, direction, resolveLinkTos) => {
	state.isFirstEnumeration = false;
	assert(streamName, `${baseErr}Stream Name not provided`);

	const connection = await connectionManager.create(config);

	function handleResult(result) {
		debug('', 'Result: %j', result);

		state.nextEventNumber = result.nextEventNumber.toNumber ? result.nextEventNumber.toNumber() : result.nextEventNumber;
		return {
			isEndOfStream: result.isEndOfStream,
			events: mapEvents(result.events)
		};
	}

	try {
		if (direction === 'forward') return await connection.readStreamEventsForward(streamName, state.nextEventNumber, length, resolveLinkTos, config.credentials).then(handleResult);
		return await connection.readStreamEventsBackward(streamName, state.nextEventNumber, length, resolveLinkTos, config.credentials).then(handleResult);
	} catch (err) {
		throw err;
	} finally {
		connection.releaseConnection();
	}
};

const esDirectionWorkaroundHandler = direction => {
	let wasSwopped = false;

	if (direction === 'forward') {
		wasSwopped = true;
		direction = 'backward';
	}

	return {
		direction,
		swopResult(state, length, result) {
			if (wasSwopped) {
				state.nextEventNumber += length + 1;
				result.events.reverse();
			}
			return result;
		}
	};
};

const stateHandler = direction => {
	class Handler {
		constructor() {
			this.isFirstEnumeration = true;
			this.setToFirst();
		}

		setToFirst() {
			this.nextEventNumber = direction === 'forward' ? 0 : -1;
		}

		setToLast(length) {
			this.nextEventNumber = direction === 'forward' ? -1 : length - 1;
		}

		setToPrevious(length) {
			if (!this.isFirstEnumeration)
				this.adjustByLength(length);
		}

		keepInBoundsAdjustment(length) {
			if (direction === 'backward')
				return length;

			let adjustment = length;
			if (this.nextEventNumber < -1) {
				adjustment -= Math.abs(this.nextEventNumber);
				this.nextEventNumber = 0;
			}

			return adjustment;
		}

		adjustByLength(length) {
			this.nextEventNumber += direction === 'forward' ? length * -1 : length;
		}
	}

	return new Handler();
};

export default (config) => (streamName, direction, resolveLinkTos) => {
	direction = direction || 'forward';
	resolveLinkTos = resolveLinkTos === undefined ? true : resolveLinkTos;
	const state = stateHandler(direction);

	return {
		first(length) {
			state.setToFirst();
			return getNextBatch(config, streamName, state, length, direction, resolveLinkTos);
		},
		last(length) {
			state.setToLast(length);

			const handler = esDirectionWorkaroundHandler(direction);
			return getNextBatch(config, streamName, state, length, handler.direction, resolveLinkTos).then(result => handler.swopResult(state, length, result));
		},
		previous(length) {
			state.setToPrevious(length);
			length = state.keepInBoundsAdjustment(length);

			return getNextBatch(config, streamName, state, length, direction, resolveLinkTos).then(result => {
				state.adjustByLength(length);
				return result;
			});
		},
		next(length) {
			return getNextBatch(config, streamName, state, length, direction, resolveLinkTos);
		}
	};
};