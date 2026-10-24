BEGIN;

ALTER TABLE sales_orders
    ADD COLUMN IF NOT EXISTS totalrefund NUMERIC(15, 2) NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'sales_orders'::regclass
          AND conname = 'sales_orders_totalrefund_nonnegative'
    ) THEN
        ALTER TABLE sales_orders
            ADD CONSTRAINT sales_orders_totalrefund_nonnegative CHECK (totalrefund >= 0);
    END IF;
END
$$;

ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS sales_orders_status_check;
ALTER TABLE sales_orders
    ADD CONSTRAINT sales_orders_status_check
    CHECK (status IN ('Pending', 'Paid', 'Delivered', 'Completed', 'Cancelled'));

CREATE OR REPLACE VIEW v_sales_orders_list AS
SELECT so.id,
       so.docno,
       so.docdate AS orderdate,
       so.totalamount,
       CASE
           WHEN so.status <> 'Cancelled'
                AND EXISTS (
                    SELECT 1
                    FROM sales_returns sr
                    WHERE sr.orderid = so.id AND sr.isactive = true
                )
           THEN 'Returned'::VARCHAR
           ELSE so.status
       END AS status,
       so.totalrefund + COALESCE(return_totals.total_refund, 0::NUMERIC) AS total_refund,
       c.name AS customer_name,
       c.phone AS customer_phone
FROM sales_orders so
LEFT JOIN customers c ON c.id = so.customerid
LEFT JOIN LATERAL (
    SELECT SUM(sr.totalrefund) AS total_refund
    FROM sales_returns sr
    WHERE sr.orderid = so.id AND sr.isactive = true
) return_totals ON true
ORDER BY so.id DESC;

CREATE OR REPLACE VIEW v_eligible_return_orders AS
SELECT so.id,
       so.docno,
       so.docdate,
       so.totalamount,
       so.status
FROM sales_orders so
WHERE so.status = 'Delivered'
  AND so.isactive = true
  AND NOT EXISTS (
      SELECT 1
      FROM sales_returns sr
      WHERE sr.orderid = so.id AND sr.isactive = true
  )
ORDER BY so.id DESC;

CREATE OR REPLACE FUNCTION fn_get_dashboard_summary()
RETURNS JSONB
LANGUAGE plpgsql
AS $function$
DECLARE
    v_monthly_orders JSONB;
    v_order_statuses JSONB;
    v_top_products JSONB;
    v_total_refund NUMERIC;
BEGIN
    SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) INTO v_monthly_orders
    FROM (
        SELECT TO_CHAR(DATE_TRUNC('month', so.docdate), 'YYYY-MM') AS month,
               COALESCE(SUM(so.totalamount - COALESCE(return_totals.total_refund, 0)), 0) AS totalamount
        FROM sales_orders so
        LEFT JOIN LATERAL (
            SELECT SUM(sr.totalrefund) AS total_refund
            FROM sales_returns sr
            WHERE sr.orderid = so.id AND sr.isactive = true
        ) return_totals ON true
        WHERE so.status <> 'Cancelled'
          AND so.isactive = true
          AND so.docdate >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '5 months'
        GROUP BY DATE_TRUNC('month', so.docdate)
        ORDER BY month
    ) t;

    SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) INTO v_order_statuses
    FROM (
        SELECT CASE
                   WHEN so.status <> 'Cancelled' AND EXISTS (
                       SELECT 1
                       FROM sales_returns sr
                       WHERE sr.orderid = so.id AND sr.isactive = true
                   )
                   THEN 'Returned'
                   ELSE so.status
               END AS status,
               COUNT(*) AS order_count
        FROM sales_orders so
        WHERE so.isactive = true
        GROUP BY 1
        ORDER BY 1
    ) t;

    SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) INTO v_top_products
    FROM (
        SELECT p.code AS product_code,
               p.name AS product_name,
               COALESCE(SUM(GREATEST(sod.quantity - COALESCE(returned.quantity_returned, 0), 0)), 0) AS quantity_sold
        FROM sales_order_details sod
        JOIN sales_orders so ON so.id = sod.orderid
        JOIN products p ON p.id = sod.productid
        LEFT JOIN (
            SELECT sr.orderid, srd.productid, srd.warehouseid,
                   SUM(srd.quantityreturned) AS quantity_returned
            FROM sales_return_details srd
            JOIN sales_returns sr ON sr.id = srd.returnid
            WHERE sr.isactive = true AND srd.isactive = true
            GROUP BY sr.orderid, srd.productid, srd.warehouseid
        ) returned ON returned.orderid = sod.orderid
                   AND returned.productid = sod.productid
                   AND returned.warehouseid IS NOT DISTINCT FROM sod.warehouseid
        WHERE so.status IN ('Paid', 'Delivered', 'Completed')
          AND so.isactive = true
          AND sod.isactive = true
        GROUP BY p.id, p.code, p.name
        HAVING SUM(GREATEST(sod.quantity - COALESCE(returned.quantity_returned, 0), 0)) > 0
        ORDER BY quantity_sold DESC, p.name
        LIMIT 8
    ) t;

    SELECT COALESCE((SELECT SUM(sr.totalrefund) FROM sales_returns sr WHERE sr.isactive = true), 0)
         + COALESCE((SELECT SUM(so.totalrefund) FROM sales_orders so WHERE so.isactive = true), 0)
    INTO v_total_refund;

    RETURN jsonb_build_object(
        'monthlyOrders', v_monthly_orders,
        'orderStatuses', v_order_statuses,
        'topProducts', v_top_products,
        'totalRefund', v_total_refund
    );
END;
$function$;

COMMIT;
