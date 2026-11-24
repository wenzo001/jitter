//! fetch_year 网络路径验证（需要网络；失败不阻塞 CI，仅打印诊断信息）。
use jitter_core::holiday;

#[tokio::test(flavor = "multi_thread")]
async fn fetch_year_returns_days() {
    let result = holiday::fetch_year_public(2026).await;
    match result {
        Ok(data) => {
            println!("year={} days={}", data.year, data.days.len());
            for day in data.days.iter().take(3) {
                println!("  {} {} {}", day.name, day.date, day.is_off_day);
            }
            assert!(!data.days.is_empty(), "holiday-cn 2026 应有数据");
        }
        Err(error) => {
            println!("fetch failed: {error}");
            // 网络不可用时不让测试失败（CI / 离线环境）。
        }
    }
}
