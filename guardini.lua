local data = cjson.decode(KEYS[1])
local key = data['key']
local limits = data['limits']
local now = tonumber(data['timestamp'])
local weight = tonumber(data['weight'] or '1')

local longest_duration = limits[1][1] or 0
local saved_keys = {}

-- handle cleanup and limit checks
for i, limit in ipairs(limits) do
    local duration = limit[1]
    longest_duration = math.max(longest_duration, duration)
    local precision = limit[3] or duration
    precision = math.min(precision, duration)
    local blocks = math.ceil(duration / precision)
    local saved = {}
    table.insert(saved_keys, saved)
    saved.block_id = math.floor(now / precision)
    saved.trim_before = saved.block_id - blocks + 1
    saved.count_key = duration .. ':' .. precision .. ':'
    saved.ts_key = saved.count_key .. 'o'

    local old_ts = redis.call('HGET', key, saved.ts_key)

    old_ts = old_ts and tonumber(old_ts) or saved.trim_before
    if old_ts > now then
        -- don't write in the past
        return 1
    end

    -- discover what needs to be cleaned up
    local decr = 0
    local dele = {}
    local trim = math.min(saved.trim_before, old_ts + blocks)
    for old_block = old_ts, trim - 1 do
        local bkey = saved.count_key .. old_block
        local bcount = redis.call('HGET', key, bkey)
        if bcount then
            decr = decr + tonumber(bcount)
            table.insert(dele, bkey)
        end
    end
    -- handle cleanup
    local cur
    if #dele > 0 then
        redis.call('HDEL', key, unpack(dele))
        cur = redis.call('HINCRBY', key, saved.count_key, -decr)
    else
        cur = redis.call('HGET', key, saved.count_key)
    end
    -- check our limits
    if tonumber(cur or '0') + weight > limit[2] then
        -- @TODO: Extract the time when this limit expires somehow
        -- @TODO: so we can reply with a retry-after number of seconds
        -- @TODO: instead of just 1
        return 1
    end
end
-- there is enough resources, update the counts
for i, limit in ipairs(limits) do
    local saved = saved_keys[i]
    -- update the current timestamp, count, and bucket count
    redis.call('HSET', key, saved.ts_key, saved.trim_before)
    redis.call('HINCRBY', key, saved.count_key, weight)
    redis.call('HINCRBY', key, saved.count_key .. saved.block_id, weight)
end
-- We calculated the longest-duration limit so we can EXPIRE
-- the whole HASH for quick and easy idle-time cleanup :)
if longest_duration > 0 then
    redis.call('EXPIRE', key, longest_duration)
end
return 0