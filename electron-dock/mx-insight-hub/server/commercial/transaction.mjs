// Existing stores own their transactions. Within a provisioning transaction,
// map those boundaries to savepoints on ONE connection, never a second pool.
// Provisioning invokes writes sequentially. Parallel/nested connect is rejected.
export function transactionPool(client) {
  let leased = false, sequence = 0
  return {
    query: (...args) => client.query(...args),
    async connect() {
      if (leased) throw new Error('Concurrent nested provisioning transaction')
      leased = true
      const name = `provisioning_${++sequence}`
      let begun = false, finished = false
      return {
        async query(sql, args) {
          const command = typeof sql === 'string' ? sql.trim().toUpperCase() : ''
          if (/^BEGIN(?:\s|$)/.test(command)) { begun = true; return client.query(`SAVEPOINT ${name}`) }
          if (command === 'COMMIT') { const result = await client.query(`RELEASE SAVEPOINT ${name}`); finished = true; return result }
          if (command === 'ROLLBACK') {
            await client.query(`ROLLBACK TO SAVEPOINT ${name}`)
            const result = await client.query(`RELEASE SAVEPOINT ${name}`); finished = true; return result
          }
          return client.query(sql, args)
        },
        release(error) {
          leased = false
          if (error || (begun && !finished)) throw error || new Error('Unfinished provisioning savepoint')
        },
      }
    },
  }
}
