import sys
import json
from pycomm3 import LogixDriver, DataError

def main():
    if len(sys.argv) < 4:
        print(json.dumps({"error": f"参数不足，需要4个，实际收到{len(sys.argv)-1}个"}))
        return

    cmd = sys.argv[1]
    ip = sys.argv[2]
    tag = sys.argv[3]
    value = sys.argv[4] if len(sys.argv) > 4 else ""

    try:
        with LogixDriver(ip) as plc:
            if not plc.connected:
                print(json.dumps({"error": "无法连接到PLC，请检查IP和网络"}))
                return

            if cmd == "read":
                try:
                    result = plc.read(tag)

                    # 兼容新旧版本：新版本用result.value，旧版本可能直接返回值
                    if hasattr(result, 'success'):
                        if result.success:
                            value = result.value
                        else:
                            print(json.dumps({"error": f"读取失败: {result.error}"}))
                            return
                    else:
                        # 旧版本直接使用返回值（无success属性）
                        value = result

                    # 转换值类型为JSON可序列化格式
                    if isinstance(value, (bool, int, float, str)):
                        print(json.dumps({"value": value}))
                    else:
                        print(json.dumps({"value": str(value)}))

                except DataError as e:
                    print(json.dumps({"error": f"标签格式错误: {str(e)}"}))
                except Exception as e:
                    print(json.dumps({"error": f"读取异常: {str(e)}"}))

            elif cmd == "write":
                if not value:
                    print(json.dumps({"error": "写入值不能为空"}))
                    return

                try:
                    # 转换值类型
                    if value.lower() == "true":
                        value = True
                    elif value.lower() == "false":
                        value = False
                    elif value.isdigit():
                        value = int(value)
                    elif "." in value and value.replace(".", "").isdigit():
                        value = float(value)

                    result = plc.write(tag, value)

                    # 兼容写入操作的返回值差异
                    if hasattr(result, 'success'):
                        if result.success:
                            print(json.dumps({"status": "success"}))
                        else:
                            print(json.dumps({"error": f"写入失败: {result.error}"}))
                    else:
                        # 旧版本写入成功直接返回True
                        print(json.dumps({"status": "success"}))

                except DataError as e:
                    print(json.dumps({"error": f"数据类型不匹配: {str(e)}"}))
                except Exception as e:
                    print(json.dumps({"error": f"写入异常: {str(e)}"}))

            else:
                print(json.dumps({"error": f"未知命令: {cmd}，支持read/write"}))

    except Exception as e:
        print(json.dumps({"error": f"PLC连接异常: {str(e)}"}))

if __name__ == "__main__":
    main()
