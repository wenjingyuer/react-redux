import React, { useState } from 'react'
import { useSelector, useDispatch, connect } from 'react-redux'
import {
  decrement,
  increment,
  incrementByAmount,
  incrementAsync,

  selectCount,
} from './counterSlice'
import styles from './Counter.module.css'

function Counter({ count,incrementIfOdd }) {
  const dispatch = useDispatch()
  const [incrementAmount, setIncrementAmount] = useState('2')

  const incrementValue = Number(incrementAmount) || 0

  return (
    <div>
      <div className={styles.row}>
        <button
          className={styles.button}
          aria-label="Decrement value"
          onClick={() => dispatch(decrement())}
        >
          -
        </button>
        <span className={styles.value}>{count}</span>
        <button
          className={styles.button}
          aria-label="Increment value"
          onClick={() => dispatch(increment())}
        >
          +
        </button>
      </div>
      <div className={styles.row}>
        <input
          className={styles.textbox}
          aria-label="Set increment amount"
          value={incrementAmount}
          onChange={(e) => setIncrementAmount(e.target.value)}
        />
        <button
          className={styles.button}
          onClick={() => dispatch(incrementByAmount(incrementValue))}
        >
          Add Amount
        </button>
        <button
          className={styles.asyncButton}
          onClick={() => dispatch(incrementAsync(incrementValue))}
        >
          Add Async
        </button>
        <button
          className={styles.button}
          onClick={() => incrementIfOdd(incrementValue)}
        >
          Add If Odd
        </button>
      </div>
    </div>
  )
}

const mapStateToProps = (state, ownProps) => ({
  count: selectCount(state),
})

const mapDispatchToProps = (dispatch, ownProps) => ({
  incrementIfOdd: (amount) => {
    const currentValue = 1
    if (currentValue % 2 === 1) {
      dispatch(incrementByAmount(amount))
    }
  },
})

export const ConnectCounter = connect(
  mapStateToProps,
  mapDispatchToProps,
)(Counter)
