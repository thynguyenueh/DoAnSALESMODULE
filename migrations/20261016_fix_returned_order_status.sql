BEGIN;

UPDATE sales_orders so
SET status = 'Delivered'
WHERE so.status = 'Cancelled'
  AND EXISTS (
      SELECT 1
      FROM sales_returns sr
      WHERE sr.orderid = so.id
        AND sr.isactive = true
  );

CREATE OR REPLACE PROCEDURE sp_create_sales_return(
    IN p_docno character varying,
    IN p_orderid integer,
    IN p_customerid integer,
    IN p_reason text,
    IN p_totalrefund numeric,
    IN p_items jsonb
)
LANGUAGE plpgsql
AS $procedure$
DECLARE
    v_orig_status VARCHAR(20);
    v_return_id INT;
    v_item RECORD;
BEGIN
    SELECT status INTO v_orig_status
    FROM sales_orders
    WHERE id = p_orderid;

    IF v_orig_status IS NULL OR v_orig_status IN ('Cancelled', 'Returned') THEN
        RAISE EXCEPTION 'Đơn hàng không hợp lệ hoặc đã bị hủy/trả!';
    END IF;

    INSERT INTO sales_returns (docno, orderid, customerid, reason, totalrefund, createdat)
    VALUES (p_docno, p_orderid, p_customerid, COALESCE(p_reason, 'Trả hàng / Hủy đơn'), p_totalrefund, CURRENT_TIMESTAMP)
    RETURNING id INTO v_return_id;

    FOR v_item IN
        SELECT *
        FROM jsonb_to_recordset(p_items) AS x(
            productid INT,
            warehouseid INT,
            quantityreturned NUMERIC,
            unitprice NUMERIC
        )
    LOOP
        INSERT INTO sales_return_details (returnid, productid, warehouseid, quantityreturned, unitprice)
        VALUES (v_return_id, v_item.productid, v_item.warehouseid, v_item.quantityreturned, v_item.unitprice);

        IF v_orig_status IN ('Paid', 'Completed') AND v_item.warehouseid IS NOT NULL THEN
            UPDATE inventory
            SET quantity = quantity + v_item.quantityreturned
            WHERE productid = v_item.productid
              AND warehouseid = v_item.warehouseid;
        END IF;
    END LOOP;

    IF p_totalrefund > 0 THEN
        INSERT INTO cash_disbursements (docno, returnid, customerid, amount, reason, createdat)
        VALUES ('PC-' || p_docno, v_return_id, p_customerid, p_totalrefund, 'Hoàn tiền trả hàng cho đơn #' || p_docno, CURRENT_TIMESTAMP);
    END IF;
END;
$procedure$;

COMMIT;
